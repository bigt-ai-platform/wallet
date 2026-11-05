/**
 * `SETTLEMENT_STORE=blob` — the engine store with no Postgres.
 *
 * Split by rebuildability (docs/p2p.md §14):
 *   - orders + swap events are a **projection of L1-SOCIAL** and live in a
 *     `MemSettlementStore`, rebuilt from the chain at boot (the watch loop
 *     replays from genesis; see server.ts main()).
 *   - payment profiles, payment proofs and escrow signings are **store-only**
 *     (PII / receipt bytes / pre-signed spend signatures) and can never come
 *     back from the chain, so they persist to the encrypted `BlobStore`.
 *
 * The projection store is injected so tests can pass a pre-warmed one.
 */
import type { BlobStore } from "./blob.js";
import { MemSettlementStore, type SettlementStore } from "./store.js";
import type { EscrowSigning, PaymentProfile, PaymentProof, PaymentVerification, P2pOrder, P2pSwapEvent, StoredPairing } from "./types.js";

const PROFILES = "profiles";
const PROOFS = "proofs";
const VERIFICATIONS = "verifications";
const PAIRINGS = "pairings";
const ESCROW = "escrow_signings";
const ORDER_FUNDS = "order_funds";
const ORDER_FUNDS_KEY = "by-order";
const SWAP_META = "swap_meta";
const SWAP_META_KEY = "by-swap";
/** One blob per order: the projection is rebuilt from L1-SOCIAL, which cannot
 *  carry an engine-intake order (the web has no P2P_SOCIAL_URL), so without
 *  this every open ad vanishes on an engine restart. */
const ORDERS = "orders";

export class BlobSettlementStore implements SettlementStore {
  /** orderId → verified legacy-EC funds h160. Orders themselves are rebuilt
   *  from L1-SOCIAL, which cannot carry this engine-local proof, so it is
   *  persisted store-only and merged back on read (docs/p2p.md §11). */
  private fundsHashes: Map<string, string> | null = null;
  private fundsLoading: Promise<Map<string, string>> | null = null;
  /** swapId → buyer receive address (store-only; the swap record omits it,
   *  and losing it makes presign/release impossible after a rebuild). */
  private swapMeta: Map<string, string> | null = null;
  private swapMetaLoading: Promise<Map<string, string>> | null = null;
  /** orderId → the latest persisted order (engine-intake orders survive a rebuild). */
  private persistedOrders: Map<string, P2pOrder> | null = null;
  private ordersLoading: Promise<Map<string, P2pOrder>> | null = null;

  constructor(
    private readonly blobs: BlobStore,
    /** Chain-derived projection (orders + swap events). Default: empty mem store. */
    readonly projection: MemSettlementStore = new MemSettlementStore(),
  ) {}

  private async loadFundsHashes(): Promise<Map<string, string>> {
    if (this.fundsHashes) return this.fundsHashes;
    if (!this.fundsLoading) {
      this.fundsLoading = (async () => {
        const saved = (await this.blobs
          .get(ORDER_FUNDS, ORDER_FUNDS_KEY)
          .catch(() => null)) as Record<string, string> | null;
        const map = new Map(Object.entries(saved ?? {}));
        this.fundsHashes = map;
        return map;
      })();
    }
    return this.fundsLoading;
  }

  private async withFundsHash(o: P2pOrder | null): Promise<P2pOrder | null> {
    if (!o || o.fundsHash) return o;
    const map = await this.loadFundsHashes();
    const hash = map.get(o.orderId);
    return hash ? { ...o, fundsHash: hash } : o;
  }

  private async loadSwapMeta(): Promise<Map<string, string>> {
    if (this.swapMeta) return this.swapMeta;
    if (!this.swapMetaLoading) {
      this.swapMetaLoading = (async () => {
        const saved = (await this.blobs
          .get(SWAP_META, SWAP_META_KEY)
          .catch(() => null)) as Record<string, string> | null;
        const map = new Map(Object.entries(saved ?? {}));
        this.swapMeta = map;
        return map;
      })();
    }
    return this.swapMetaLoading;
  }

  private async withReceive(e: P2pSwapEvent | null): Promise<P2pSwapEvent | null> {
    if (!e || e.receiveAddress) return e;
    const address = (await this.loadSwapMeta()).get(e.swapId);
    return address ? { ...e, receiveAddress: address } : e;
  }

  private async loadPersistedOrders(): Promise<Map<string, P2pOrder>> {
    if (this.persistedOrders) return this.persistedOrders;
    if (!this.ordersLoading) {
      this.ordersLoading = (async () => {
        const map = new Map<string, P2pOrder>();
        const keys = await this.blobs.list(ORDERS).catch(() => []);
        for (const key of keys) {
          const o = (await this.blobs.get(ORDERS, key).catch(() => null)) as P2pOrder | null;
          if (o && typeof o.orderId === "string") map.set(o.orderId, o);
        }
        this.persistedOrders = map;
        return map;
      })();
    }
    return this.ordersLoading;
  }

  private async persistOrder(o: P2pOrder): Promise<void> {
    const map = await this.loadPersistedOrders();
    map.set(o.orderId, o);
    await this.blobs.put(ORDERS, o.orderId, o).catch(() => {});
  }

  private async persistCurrentOrder(orderId: string): Promise<void> {
    const o = await this.projection.getOrder(orderId);
    if (o) await this.persistOrder(o);
  }

  // ── chain-derived projection (delegated to the mem projection) ──────────
  async createOrder(o: P2pOrder): Promise<void> {
    await this.projection.createOrder(o);
    await this.persistOrder(o);
  }
  async getOrder(orderId: string): Promise<P2pOrder | null> {
    const projected = await this.projection.getOrder(orderId);
    if (projected) return this.withFundsHash(projected);
    const saved = (await this.loadPersistedOrders()).get(orderId) ?? null;
    if (!saved) return null;
    // Re-seed the projection so markOrderMatched/markOrderCancelled can work.
    await this.projection.createOrder(saved).catch(() => {});
    return this.withFundsHash(saved);
  }
  async setOrderFundsHash(orderId: string, fundsHash: string): Promise<void> {
    await this.projection.setOrderFundsHash(orderId, fundsHash);
    const map = await this.loadFundsHashes();
    if (map.get(orderId) !== fundsHash) {
      map.set(orderId, fundsHash);
      // Advisory data: a blob write failure must not fail the order itself.
      await this.blobs.put(ORDER_FUNDS, ORDER_FUNDS_KEY, Object.fromEntries(map)).catch(() => {});
    }
    await this.persistCurrentOrder(orderId);
  }
  async listOrders(status?: string): Promise<P2pOrder[]> {
    const rows = await this.projection.listOrders(status);
    const byId = new Map(rows.map((o) => [o.orderId, o]));
    for (const o of (await this.loadPersistedOrders()).values()) {
      if (status && o.status !== status) continue;
      if (!byId.has(o.orderId)) byId.set(o.orderId, o);
    }
    const merged = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    // Seed persisted orders missing from the volatile projection (fresh boot).
    for (const o of merged) {
      if (!rows.some((r) => r.orderId === o.orderId)) {
        await this.projection.createOrder(o).catch(() => {});
      }
    }
    const withFunds = await Promise.all(merged.map((o) => this.withFundsHash(o)));
    return withFunds.filter((o): o is P2pOrder => !!o);
  }
  async markOrderMatched(orderId: string, swapId: string, remainingGive?: string, expectedRemaining?: string): Promise<boolean> {
    const ok = await this.projection.markOrderMatched(orderId, swapId, remainingGive, expectedRemaining);
    if (ok) await this.persistCurrentOrder(orderId);
    return ok;
  }
  async markOrderCancelled(orderId: string): Promise<boolean> {
    const ok = await this.projection.markOrderCancelled(orderId);
    if (ok) await this.persistCurrentOrder(orderId);
    return ok;
  }
  async reopenOrder(orderId: string, swapId: string): Promise<void> {
    await this.projection.reopenOrder(orderId, swapId);
    await this.persistCurrentOrder(orderId);
  }
  hasOrderReservation(orderId: string, swapId: string): Promise<boolean> {
    return this.projection.hasOrderReservation(orderId, swapId);
  }
  async appendEvent(e: P2pSwapEvent, prepare?: () => Promise<P2pSwapEvent>): Promise<void> {
    await this.projection.appendEvent(e, prepare);
    // The buyer's release destination is store-only (not in the swap record):
    // keep it across projection rebuilds, not just in the volatile projection.
    const stored = await this.projection.getSwap(e.swapId);
    if (stored?.receiveAddress) {
      await this.setSwapReceiveAddress(e.swapId, stored.receiveAddress);
    }
  }
  events(swapId: string): Promise<P2pSwapEvent[]> {
    return this.projection.events(swapId);
  }
  async getSwap(swapId: string): Promise<P2pSwapEvent | null> {
    return this.withReceive(await this.projection.getSwap(swapId));
  }
  async setSwapReceiveAddress(swapId: string, address: string): Promise<void> {
    await this.projection.setSwapReceiveAddress(swapId, address);
    const map = await this.loadSwapMeta();
    if (map.get(swapId) === address) return;
    map.set(swapId, address);
    await this.blobs.put(SWAP_META, SWAP_META_KEY, Object.fromEntries(map)).catch(() => {});
  }
  async listSwaps(limit?: number): Promise<P2pSwapEvent[]> {
    const rows = await this.projection.listSwaps(limit);
    const merged = await Promise.all(rows.map((e) => this.withReceive(e)));
    return merged.filter((e): e is P2pSwapEvent => !!e);
  }
  async listSwapsForDid(did: string, limit?: number): Promise<P2pSwapEvent[]> {
    const rows = await this.projection.listSwapsForDid(did, limit);
    const merged = await Promise.all(rows.map((e) => this.withReceive(e)));
    return merged.filter((e): e is P2pSwapEvent => !!e);
  }
  allEvents(): Promise<P2pSwapEvent[]> {
    return this.projection.allEvents();
  }

  // ── store-only, durable in the encrypted blob store ─────────────────────
  async getProfile(sellerDid: string, method: string): Promise<PaymentProfile | null> {
    return (await this.blobs.get(PROFILES, `${sellerDid}|${method}`)) as PaymentProfile | null;
  }

  async listProfiles(sellerDid: string): Promise<PaymentProfile[]> {
    const keys = await this.blobs.list(PROFILES);
    const out: PaymentProfile[] = [];
    for (const key of keys) {
      if (!key.startsWith(`${sellerDid}|`)) continue;
      const p = (await this.blobs.get(PROFILES, key)) as PaymentProfile | null;
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.method.localeCompare(b.method));
  }

  async upsertProfile(p: PaymentProfile): Promise<void> {
    await this.blobs.put(PROFILES, `${p.sellerDid}|${p.method}`, p);
  }

  async addProof(p: PaymentProof): Promise<void> {
    const list = ((await this.blobs.get(PROOFS, p.swapId)) as PaymentProof[] | null) ?? [];
    list.push(p);
    await this.blobs.put(PROOFS, p.swapId, list);
  }

  async proofs(swapId: string): Promise<PaymentProof[]> {
    return ((await this.blobs.get(PROOFS, swapId)) as PaymentProof[] | null) ?? [];
  }

  async addVerification(v: PaymentVerification): Promise<void> {
    const list = ((await this.blobs.get(VERIFICATIONS, v.swapId)) as PaymentVerification[] | null) ?? [];
    list.push(v);
    await this.blobs.put(VERIFICATIONS, v.swapId, list);
  }

  async verifications(swapId: string): Promise<PaymentVerification[]> {
    return ((await this.blobs.get(VERIFICATIONS, swapId)) as PaymentVerification[] | null) ?? [];
  }

  async putPairing(p: StoredPairing): Promise<void> {
    await this.blobs.put(PAIRINGS, `${p.did}|${p.pairingId}`, p);
  }

  async getPairing(did: string, pairingId: string): Promise<StoredPairing | null> {
    return ((await this.blobs.get(PAIRINGS, `${did}|${pairingId}`)) as StoredPairing | null) ?? null;
  }

  async pairingsForDid(did: string): Promise<StoredPairing[]> {
    const keys = await this.blobs.list(PAIRINGS);
    const out: StoredPairing[] = [];
    for (const key of keys) {
      if (!key.startsWith(`${did}|`)) continue;
      const p = (await this.blobs.get(PAIRINGS, key)) as StoredPairing | null;
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async putEscrowSigning(s: EscrowSigning): Promise<void> {
    await this.blobs.put(ESCROW, s.swapId, s);
  }

  async getEscrowSigning(swapId: string): Promise<EscrowSigning | null> {
    return (await this.blobs.get(ESCROW, swapId)) as EscrowSigning | null;
  }
}
