/**
 * Settlement store (docs/p2p.md). Orders are the engine's intake; swaps are an
 * append-only event log whose current state is the latest event. Both are
 * rebuildable (the on-chain `social.p2p-swap` records are the durable audit
 * seed), so Postgres here is a projection, per AGENTS.md invariant #1 — the
 * append-only shape means a replay never mutates history.
 */
import type { EscrowSigning, PaymentProfile, PaymentProof, P2pOrder, P2pSwapEvent } from "./types.js";
import type { BlobStore } from "./blob.js";

/** Blob collection for buyer receipt bytes (docs/p2p.md §14). */
const RECEIPTS = "receipts";

export interface SettlementStore {
  createOrder(o: P2pOrder): Promise<void>;
  getOrder(orderId: string): Promise<P2pOrder | null>;
  listOrders(status?: string): Promise<P2pOrder[]>;
  /** ACTIVE → MATCHED. Returns false when the order was not ACTIVE (lost race). */
  markOrderMatched(orderId: string, swapId: string): Promise<boolean>;
  /** ACTIVE → CANCELLED. Returns false when the order was not ACTIVE (lost race). */
  markOrderCancelled(orderId: string): Promise<boolean>;
  /** Undo a match whose event never anchored: ACTIVE again, only for `swapId`. */
  reopenOrder(orderId: string, swapId: string): Promise<void>;
  appendEvent(e: P2pSwapEvent): Promise<void>;
  events(swapId: string): Promise<P2pSwapEvent[]>;
  /** The whole append-only log — input for derived projections (reputation). */
  allEvents(): Promise<P2pSwapEvent[]>;
  getSwap(swapId: string): Promise<P2pSwapEvent | null>;
  /** Latest event per swap, newest first (the swap's current state). */
  listSwaps(limit?: number): Promise<P2pSwapEvent[]>;
  /** Latest event per swap where `did` is the seller or buyer (party-scoped reads). */
  listSwapsForDid(did: string, limit?: number): Promise<P2pSwapEvent[]>;
  /** The seller's collection profile for one rail (docs/p2p.md §11). */
  getProfile(sellerDid: string, method: string): Promise<PaymentProfile | null>;
  /** All CNY profiles the seller has saved. */
  listProfiles(sellerDid: string): Promise<PaymentProfile[]>;
  upsertProfile(p: PaymentProfile): Promise<void>;
  /** Append a buyer payment proof (multiple kept: overwrites before confirm). */
  addProof(p: PaymentProof): Promise<void>;
  proofs(swapId: string): Promise<PaymentProof[]>;
  /** Upsert the escrow spend signatures / submitted tx for one swap. */
  putEscrowSigning(s: EscrowSigning): Promise<void>;
  getEscrowSigning(swapId: string): Promise<EscrowSigning | null>;
}

export class MemSettlementStore implements SettlementStore {
  readonly orders = new Map<string, P2pOrder>();
  readonly swapEvents = new Map<string, P2pSwapEvent[]>();
  readonly paymentProfiles = new Map<string, PaymentProfile>();
  readonly paymentProofs = new Map<string, PaymentProof[]>();
  readonly escrowSignings = new Map<string, EscrowSigning>();

  async createOrder(o: P2pOrder): Promise<void> {
    if (!this.orders.has(o.orderId)) this.orders.set(o.orderId, o);
  }

  async getOrder(orderId: string): Promise<P2pOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async listOrders(status?: string): Promise<P2pOrder[]> {
    return [...this.orders.values()]
      .filter((o) => !status || o.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  async markOrderMatched(orderId: string, swapId: string): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "ACTIVE") return false;
    this.orders.set(orderId, { ...o, status: "MATCHED", swapId });
    return true;
  }

  async markOrderCancelled(orderId: string): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "ACTIVE") return false;
    this.orders.set(orderId, { ...o, status: "CANCELLED" });
    return true;
  }

  async reopenOrder(orderId: string, swapId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && o.status === "MATCHED" && o.swapId === swapId) {
      this.orders.set(orderId, { ...o, status: "ACTIVE", swapId: undefined });
    }
  }

  async appendEvent(e: P2pSwapEvent): Promise<void> {
    const list = this.swapEvents.get(e.swapId) ?? [];
    if (!list.some((x) => x.seq === e.seq)) list.push(e);
    list.sort((a, b) => a.seq - b.seq);
    this.swapEvents.set(e.swapId, list);
  }

  async events(swapId: string): Promise<P2pSwapEvent[]> {
    return [...(this.swapEvents.get(swapId) ?? [])];
  }

  async allEvents(): Promise<P2pSwapEvent[]> {
    return [...this.swapEvents.values()].flat();
  }

  async getSwap(swapId: string): Promise<P2pSwapEvent | null> {
    const list = this.swapEvents.get(swapId) ?? [];
    return list.length ? list[list.length - 1] : null;
  }

  async listSwaps(limit = 100): Promise<P2pSwapEvent[]> {
    return [...this.swapEvents.values()]
      .map((list) => list[list.length - 1])
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  async listSwapsForDid(did: string, limit = 100): Promise<P2pSwapEvent[]> {
    return [...this.swapEvents.values()]
      .map((list) => list[list.length - 1])
      .filter((s) => s.sellerDid === did || s.buyerDid === did)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  async getProfile(sellerDid: string, method: string): Promise<PaymentProfile | null> {
    return this.paymentProfiles.get(`${sellerDid}|${method}`) ?? null;
  }

  async listProfiles(sellerDid: string): Promise<PaymentProfile[]> {
    return [...this.paymentProfiles.values()].filter((p) => p.sellerDid === sellerDid).sort((a, b) => a.method.localeCompare(b.method));
  }

  async upsertProfile(p: PaymentProfile): Promise<void> {
    this.paymentProfiles.set(`${p.sellerDid}|${p.method}`, p);
  }

  async addProof(p: PaymentProof): Promise<void> {
    const list = this.paymentProofs.get(p.swapId) ?? [];
    list.push(p);
    this.paymentProofs.set(p.swapId, list);
  }

  async proofs(swapId: string): Promise<PaymentProof[]> {
    return [...(this.paymentProofs.get(swapId) ?? [])];
  }

  async putEscrowSigning(s: EscrowSigning): Promise<void> {
    this.escrowSignings.set(s.swapId, { ...s });
  }

  async getEscrowSigning(swapId: string): Promise<EscrowSigning | null> {
    return this.escrowSignings.get(swapId) ?? null;
  }
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

function orderFromRow(row: any): P2pOrder {
  return {
    orderId: row.order_id,
    type: row.type,
    sellerDid: row.seller_did,
    giveToken: row.give_token,
    giveAmount: row.give_amount,
    giveChain: row.give_chain,
    wantCurrency: row.want_currency,
    wantAmount: row.want_amount,
    wantRail: row.want_rail,
    validUntil: Number(row.valid_until),
    status: row.status,
    signature: row.signature,
    swapId: row.swap_id ?? undefined,
    txid: row.txid ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export class PgSettlementStore implements SettlementStore {
  /**
   * `blobs` (optional) moves the buyer's receipt **bytes** out of Postgres into
   * the durable blob store (MinIO/Drive); the row keeps only `receipt_sha256`
   * and a ref. The image is evidence, not a row anyone queries — a DB should
   * not carry the bytes.
   */
  constructor(private readonly db: Queryable, private readonly blobs: BlobStore | null = null) {}

  async createOrder(o: P2pOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO p2p_orders (order_id, seller_did, type, give_token, give_amount, give_chain,
         want_currency, want_amount, want_rail, valid_until, status, signature, swap_id, txid, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (order_id) DO NOTHING`,
      [
        o.orderId,
        o.sellerDid,
        o.type,
        o.giveToken,
        o.giveAmount,
        o.giveChain,
        o.wantCurrency,
        o.wantAmount,
        o.wantRail,
        o.validUntil,
        o.status,
        o.signature,
        o.swapId ?? null,
        o.txid ?? null,
        new Date(o.createdAt),
      ],
    );
  }

  async getOrder(orderId: string): Promise<P2pOrder | null> {
    const res = await this.db.query(`SELECT * FROM p2p_orders WHERE order_id = $1`, [orderId]);
    return res.rows[0] ? orderFromRow(res.rows[0]) : null;
  }

  async listOrders(status?: string): Promise<P2pOrder[]> {
    const res = status
      ? await this.db.query(`SELECT * FROM p2p_orders WHERE status = $1 ORDER BY created_at DESC LIMIT 100`, [status])
      : await this.db.query(`SELECT * FROM p2p_orders ORDER BY created_at DESC LIMIT 100`);
    return res.rows.map(orderFromRow);
  }

  async markOrderMatched(orderId: string, swapId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE p2p_orders SET status = 'MATCHED', swap_id = $2 WHERE order_id = $1 AND status = 'ACTIVE'`,
      [orderId, swapId],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async markOrderCancelled(orderId: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE p2p_orders SET status = 'CANCELLED' WHERE order_id = $1 AND status = 'ACTIVE'`,
      [orderId],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async reopenOrder(orderId: string, swapId: string): Promise<void> {
    await this.db.query(
      `UPDATE p2p_orders SET status = 'ACTIVE', swap_id = NULL
       WHERE order_id = $1 AND status = 'MATCHED' AND swap_id = $2`,
      [orderId, swapId],
    );
  }

  async appendEvent(e: P2pSwapEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO p2p_swap_events (swap_id, event_seq, status, event_type, actor_did, payload, txid, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (swap_id, event_seq) DO NOTHING`,
      [e.swapId, e.seq, e.status, e.eventType, e.actorDid ?? null, JSON.stringify(e), e.txid ?? null, new Date(e.at)],
    );
  }

  async events(swapId: string): Promise<P2pSwapEvent[]> {
    const res = await this.db.query(
      `SELECT payload FROM p2p_swap_events WHERE swap_id = $1 ORDER BY event_seq`,
      [swapId],
    );
    return res.rows.map((r) => r.payload as P2pSwapEvent);
  }

  async allEvents(): Promise<P2pSwapEvent[]> {
    const res = await this.db.query(`SELECT payload FROM p2p_swap_events ORDER BY swap_id, event_seq`);
    return res.rows.map(rowEvent);
  }

  async getSwap(swapId: string): Promise<P2pSwapEvent | null> {
    const res = await this.db.query(
      `SELECT payload FROM p2p_swap_events WHERE swap_id = $1 ORDER BY event_seq DESC LIMIT 1`,
      [swapId],
    );
    return res.rows[0] ? rowEvent(res.rows[0]) : null;
  }

  async listSwaps(limit = 100): Promise<P2pSwapEvent[]> {
    const res = await this.db.query(
      `SELECT payload FROM p2p_swap_events e
       JOIN (SELECT swap_id, MAX(event_seq) AS seq FROM p2p_swap_events GROUP BY swap_id) t
         ON t.swap_id = e.swap_id AND t.seq = e.event_seq
       ORDER BY e.created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(rowEvent);
  }

  async listSwapsForDid(did: string, limit = 100): Promise<P2pSwapEvent[]> {
    const res = await this.db.query(
      `SELECT payload FROM p2p_swap_events e
       JOIN (SELECT swap_id, MAX(event_seq) AS seq FROM p2p_swap_events GROUP BY swap_id) t
         ON t.swap_id = e.swap_id AND t.seq = e.event_seq
       WHERE e.payload->>'sellerDid' = $1 OR e.payload->>'buyerDid' = $1
       ORDER BY e.created_at DESC LIMIT $2`,
      [did, limit],
    );
    return res.rows.map(rowEvent);
  }

  async getProfile(sellerDid: string, method: string): Promise<PaymentProfile | null> {
    const res = await this.db.query(`SELECT * FROM p2p_payment_profiles WHERE seller_did = $1 AND method = $2`, [
      sellerDid,
      method,
    ]);
    return res.rows[0] ? profileFromRow(res.rows[0]) : null;
  }

  async listProfiles(sellerDid: string): Promise<PaymentProfile[]> {
    const res = await this.db.query(`SELECT * FROM p2p_payment_profiles WHERE seller_did = $1 ORDER BY method`, [
      sellerDid,
    ]);
    return res.rows.map(profileFromRow);
  }

  async upsertProfile(p: PaymentProfile): Promise<void> {
    await this.db.query(
      `INSERT INTO p2p_payment_profiles (seller_did, method, account_name, account, bank_name, qr, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (seller_did, method) DO UPDATE
         SET account_name = EXCLUDED.account_name, account = EXCLUDED.account,
             bank_name = EXCLUDED.bank_name, qr = EXCLUDED.qr, updated_at = EXCLUDED.updated_at`,
      [p.sellerDid, p.method, p.accountName, p.account, p.bankName ?? null, p.qr ?? null, new Date(p.updatedAt)],
    );
  }

  async addProof(p: PaymentProof): Promise<void> {
    let receipt = p.receipt ?? null;
    let receiptRef: string | null = null;
    if (receipt && this.blobs) {
      receiptRef = `${p.swapId}:${p.txId}:${p.createdAt}`;
      await this.blobs.put(RECEIPTS, receiptRef, { receipt });
      receipt = null; // the bytes live in the blob store, not the DB row
    }
    await this.db.query(
      `INSERT INTO p2p_payment_proofs (swap_id, tx_id, remark, receipt_sha256, receipt, receipt_ref, paid_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.swapId, p.txId, p.remark ?? null, p.receiptSha256 ?? null, receipt, receiptRef, p.paidAt ?? null, new Date(p.createdAt)],
    );
  }

  async proofs(swapId: string): Promise<PaymentProof[]> {
    const res = await this.db.query(
      `SELECT swap_id, tx_id, remark, receipt_sha256, receipt, receipt_ref, paid_at, created_at
       FROM p2p_payment_proofs WHERE swap_id = $1 ORDER BY seq`,
      [swapId],
    );
    const out: PaymentProof[] = [];
    for (const r of res.rows as any[]) {
      let receipt: string | undefined = r.receipt ?? undefined;
      if (!receipt && r.receipt_ref && this.blobs) {
        const blob = await this.blobs.get(RECEIPTS, r.receipt_ref);
        if (typeof blob?.receipt === "string") receipt = blob.receipt;
      }
      out.push({
        swapId: r.swap_id,
        txId: r.tx_id,
        ...(r.remark ? { remark: r.remark } : {}),
        ...(r.receipt_sha256 ? { receiptSha256: r.receipt_sha256 } : {}),
        ...(receipt ? { receipt } : {}),
        ...(r.paid_at != null ? { paidAt: Number(r.paid_at) } : {}),
        createdAt: new Date(r.created_at).getTime(),
      });
    }
    return out;
  }

  async putEscrowSigning(s: EscrowSigning): Promise<void> {
    await this.db.query(
      `INSERT INTO p2p_escrow_signings
         (swap_id, refund_address, release_sig, refund_sig, release_signer_did, refund_signer_did,
          seller_did, release_txhash, refund_txhash, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (swap_id) DO UPDATE SET
         refund_address     = EXCLUDED.refund_address,
         release_sig        = EXCLUDED.release_sig,
         refund_sig         = EXCLUDED.refund_sig,
         release_signer_did = EXCLUDED.release_signer_did,
         refund_signer_did  = EXCLUDED.refund_signer_did,
         seller_did         = EXCLUDED.seller_did,
         release_txhash     = EXCLUDED.release_txhash,
         refund_txhash      = EXCLUDED.refund_txhash,
         updated_at         = EXCLUDED.updated_at`,
      [
        s.swapId,
        s.refundAddress,
        s.releaseSig,
        s.refundSig,
        s.releaseSignerDid,
        s.refundSignerDid,
        s.sellerDid,
        s.releaseTxHash ?? null,
        s.refundTxHash ?? null,
        new Date(s.createdAt),
        new Date(s.updatedAt),
      ],
    );
  }

  async getEscrowSigning(swapId: string): Promise<EscrowSigning | null> {
    const res = await this.db.query(`SELECT * FROM p2p_escrow_signings WHERE swap_id = $1`, [swapId]);
    return res.rows[0] ? escrowSigningFromRow(res.rows[0]) : null;
  }
}

function escrowSigningFromRow(row: any): EscrowSigning {
  return {
    swapId: row.swap_id,
    refundAddress: row.refund_address ?? "",
    releaseSig: row.release_sig ?? "",
    refundSig: row.refund_sig ?? "",
    releaseSignerDid: row.release_signer_did ?? "",
    refundSignerDid: row.refund_signer_did ?? "",
    sellerDid: row.seller_did ?? "",
    releaseTxHash: row.release_txhash ?? null,
    refundTxHash: row.refund_txhash ?? null,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

function profileFromRow(row: any): PaymentProfile {
  return {
    sellerDid: row.seller_did,
    method: row.method,
    accountName: row.account_name,
    account: row.account,
    ...(row.bank_name ? { bankName: row.bank_name } : {}),
    ...(row.qr ? { qr: row.qr } : {}),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

function rowEvent(row: { payload: unknown }): P2pSwapEvent {
  const payload = row.payload;
  return typeof payload === "string" ? (JSON.parse(payload) as P2pSwapEvent) : (payload as P2pSwapEvent);
}
