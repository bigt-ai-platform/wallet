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
import type { EscrowSigning, PaymentProfile, PaymentProof, P2pOrder, P2pSwapEvent } from "./types.js";

const PROFILES = "profiles";
const PROOFS = "proofs";
const ESCROW = "escrow_signings";

export class BlobSettlementStore implements SettlementStore {
  constructor(
    private readonly blobs: BlobStore,
    /** Chain-derived projection (orders + swap events). Default: empty mem store. */
    readonly projection: MemSettlementStore = new MemSettlementStore(),
  ) {}

  // ── chain-derived projection (delegated to the mem projection) ──────────
  createOrder(o: P2pOrder): Promise<void> {
    return this.projection.createOrder(o);
  }
  getOrder(orderId: string): Promise<P2pOrder | null> {
    return this.projection.getOrder(orderId);
  }
  listOrders(status?: string): Promise<P2pOrder[]> {
    return this.projection.listOrders(status);
  }
  markOrderMatched(orderId: string, swapId: string): Promise<boolean> {
    return this.projection.markOrderMatched(orderId, swapId);
  }
  markOrderCancelled(orderId: string): Promise<boolean> {
    return this.projection.markOrderCancelled(orderId);
  }
  reopenOrder(orderId: string, swapId: string): Promise<void> {
    return this.projection.reopenOrder(orderId, swapId);
  }
  appendEvent(e: P2pSwapEvent): Promise<void> {
    return this.projection.appendEvent(e);
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

  async putEscrowSigning(s: EscrowSigning): Promise<void> {
    await this.blobs.put(ESCROW, s.swapId, s);
  }

  async getEscrowSigning(swapId: string): Promise<EscrowSigning | null> {
    return (await this.blobs.get(ESCROW, swapId)) as EscrowSigning | null;
  }
}
