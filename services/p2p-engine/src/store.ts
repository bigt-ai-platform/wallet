/**
 * Settlement store (docs/p2p.md). Orders are the engine's intake; swaps are an
 * append-only event log whose current state is the latest event. Both are
 * rebuildable (the on-chain `social.p2p-swap` records are the durable audit
 * seed), so Postgres here is a projection, per AGENTS.md invariant #1 — the
 * append-only shape means a replay never mutates history.
 */
import type { P2pOrder, P2pSwapEvent } from "./types.js";

export interface SettlementStore {
  createOrder(o: P2pOrder): Promise<void>;
  getOrder(orderId: string): Promise<P2pOrder | null>;
  listOrders(status?: string): Promise<P2pOrder[]>;
  markOrderMatched(orderId: string, swapId: string): Promise<void>;
  appendEvent(e: P2pSwapEvent): Promise<void>;
  events(swapId: string): Promise<P2pSwapEvent[]>;
  getSwap(swapId: string): Promise<P2pSwapEvent | null>;
  /** Latest event per swap, newest first (the swap's current state). */
  listSwaps(limit?: number): Promise<P2pSwapEvent[]>;
  /** Latest event per swap where `did` is the seller or buyer (party-scoped reads). */
  listSwapsForDid(did: string, limit?: number): Promise<P2pSwapEvent[]>;
  /** Resolve a swap by id, payout batch id, or invoice id (webhook correlation). */
  findSwapByRef(ref: string): Promise<P2pSwapEvent | null>;
}

export class MemSettlementStore implements SettlementStore {
  readonly orders = new Map<string, P2pOrder>();
  readonly swapEvents = new Map<string, P2pSwapEvent[]>();

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

  async markOrderMatched(orderId: string, swapId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o) this.orders.set(orderId, { ...o, status: "MATCHED", swapId });
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

  async findSwapByRef(ref: string): Promise<P2pSwapEvent | null> {
    for (const list of this.swapEvents.values()) {
      const latest = list[list.length - 1];
      if (latest && (latest.swapId === ref || latest.payoutRef === ref || latest.invoiceId === ref)) return latest;
    }
    return null;
  }
}

interface Queryable {
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
    createdAt: new Date(row.created_at).getTime(),
  };
}

export class PgSettlementStore implements SettlementStore {
  constructor(private readonly db: Queryable) {}

  async createOrder(o: P2pOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO p2p_orders (order_id, seller_did, type, give_token, give_amount, give_chain,
         want_currency, want_amount, want_rail, valid_until, status, signature, swap_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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

  async markOrderMatched(orderId: string, swapId: string): Promise<void> {
    await this.db.query(`UPDATE p2p_orders SET status = 'MATCHED', swap_id = $2 WHERE order_id = $1`, [orderId, swapId]);
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

  async findSwapByRef(ref: string): Promise<P2pSwapEvent | null> {
    const res = await this.db.query(
      `SELECT payload FROM p2p_swap_events e
       JOIN (SELECT swap_id, MAX(event_seq) AS seq FROM p2p_swap_events GROUP BY swap_id) t
         ON t.swap_id = e.swap_id AND t.seq = e.event_seq
       WHERE e.swap_id = $1 OR e.payload->>'payoutRef' = $1 OR e.payload->>'invoiceId' = $1
       LIMIT 1`,
      [ref],
    );
    return res.rows[0] ? rowEvent(res.rows[0]) : null;
  }
}

function rowEvent(row: { payload: unknown }): P2pSwapEvent {
  const payload = row.payload;
  return typeof payload === "string" ? (JSON.parse(payload) as P2pSwapEvent) : (payload as P2pSwapEvent);
}
