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

export class BlobSettlementStore implements SettlementStore {
  /** orderId → verified legacy-EC funds h160. Orders themselves are rebuilt
   *  from L1-SOCIAL, which cannot carry this engine-local proof, so it is
   *  persisted store-only and merged back on read (docs/p2p.md §11). */
  private fundsHashes: Map<string, string> | null = null;
  private fundsLoading: Promise<Map<string, string>> | null = null;

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

  // ── chain-derived projection (delegated to the mem projection) ──────────
  createOrder(o: P2pOrder): Promise<void> {
    return this.projection.createOrder(o);
  }
  async getOrder(orderId: string): Promise<P2pOrder | null> {
    return this.withFundsHash(await this.projection.getOrder(orderId));
  }
  async setOrderFundsHash(orderId: string, fundsHash: string): Promise<void> {
    await this.projection.setOrderFundsHash(orderId, fundsHash);
    const map = await this.loadFundsHashes();
    if (map.get(orderId) === fundsHash) return;
    map.set(orderId, fundsHash);
    // Advisory data: a blob write failure must not fail the order itself.
    await this.blobs.put(ORDER_FUNDS, ORDER_FUNDS_KEY, Object.fromEntries(map)).catch(() => {});
  }
  async listOrders(status?: string): Promise<P2pOrder[]> {
    const rows = await this.projection.listOrders(status);
    const merged = await Promise.all(rows.map((o) => this.withFundsHash(o)));
    return merged.filter((o): o is P2pOrder => !!o);
  }
  markOrderMatched(orderId: string, swapId: string, remainingGive?: string, expectedRemaining?: string): Promise<boolean> {
    return this.projection.markOrderMatched(orderId, swapId, remainingGive, expectedRemaining);
  }
  markOrderCancelled(orderId: string): Promise<boolean> {
    return this.projection.markOrderCancelled(orderId);
  }
  reopenOrder(orderId: string, swapId: string): Promise<void> {
    return this.projection.reopenOrder(orderId, swapId);
  }
  hasOrderReservation(orderId: string, swapId: string): Promise<boolean> {
    return this.projection.hasOrderReservation(orderId, swapId);
  }
  appendEvent(e: P2pSwapEvent, prepare?: () => Promise<P2pSwapEvent>): Promise<void> {
    return this.projection.appendEvent(e, prepare);
  }
  events(swapId: string): Promise<P2pSwapEvent[]> {
    return this.projection.events(swapId);
  }
  getSwap(swapId: string): Promise<P2pSwapEvent | null> {
    return this.projection.getSwap(swapId);
  }
  listSwaps(limit?: number): Promise<P2pSwapEvent[]> {
    return this.projection.listSwaps(limit);
  }
  listSwapsForDid(did: string, limit?: number): Promise<P2pSwapEvent[]> {
    return this.projection.listSwapsForDid(did, limit);
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
