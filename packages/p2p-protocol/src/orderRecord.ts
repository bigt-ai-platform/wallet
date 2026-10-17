/**
 * `social.p2p-order` — the seller-anchored order-book record.
 *
 * The seller builds, author-signs (record-sig over the canonical record JSON)
 * and submits this record to L1-SOCIAL from their own wallet key — the engine
 * never authors it, it only verifies and indexes. The record is PII-free: it
 * carries exactly the fields the public order book already exposes.
 *
 * `to` is the opaque `orderId`; `orderSeq` orders records per order (0 = OPEN,
 * 1 = CANCELLED) so a cancel replays deterministically. `MATCHED` is never
 * seller-asserted: it is derived from the engine-anchored `social.p2p-swap`
 * event that references the order (docs/p2p.md §9).
 */

export const P2P_ORDER_TYPE = "social.p2p-order";

/** OPEN introduces the order; CANCELLED is the seller's terminal withdraw. */
export const P2P_ORDER_RECORD_STATUSES = ["OPEN", "CANCELLED"] as const;
export type P2pOrderRecordStatus = (typeof P2P_ORDER_RECORD_STATUSES)[number];

export interface P2pOrderRecord {
  type: typeof P2P_ORDER_TYPE;
  /** did:key of the author — the seller. */
  from: string;
  /** the opaque orderId (`ord-<16hex>`). */
  to: string;
  ts: number;
  status: P2pOrderRecordStatus;
  /** monotonic per-order sequence (0 = OPEN, 1 = CANCELLED). */
  orderSeq: number;
  giveToken?: string;
  giveAmount?: string;
  giveChain?: string;
  wantCurrency?: string;
  wantAmount?: string;
  wantRail?: string;
  /** unix seconds after which the order can no longer be matched */
  validUntil?: number;
  /**
   * The engine's escrow participant pubkey this order was created against
   * (prefixed ML-DSA public key hex — docs/p2p.md §26.6). Pinned per order so
   * the buyer derives the *same* 2-of-3 vault from the chain, without fetching
   * `GET /capabilities` and without being tied to one global engine. Optional
   * for backward compatibility; when present it is authoritative over the
   * engine a wallet happens to be configured with.
   */
  enginePubkey?: string;
  /**
   * Order side (docs/p2p.md): `sell` (default) — the author gives tokens; `buy`
   * — the author pays fiat and wants tokens (a bid the taker fills by selling).
   * The token giver always funds the escrow; fiat always moves buyer → seller.
   */
  side?: "sell" | "buy";
  /**
   * For a `buy` bid: where the author (the buyer) wants the tokens delivered.
   * It is the buyer's own public address, and the taker needs the escrow to
   * release there — the engine derives the release destination from it.
   */
  buyerReceiveAddress?: string;
  /** Per-order fiat limit (Binance-style): a taker's order must be at least
   *  `minOrder` and at most `maxOrder` fiat, bounded by the total. */
  minOrder?: string;
  maxOrder?: string;
  /** Payment window in minutes (Binance: 15..180) the buyer is given to pay. */
  timeLimit?: number;
  /** Free-text ad terms/instructions shown to the counterparty. */
  remarks?: string;
}

export interface P2pOrderRecordInput extends Omit<P2pOrderRecord, "type" | "ts" | "status" | "orderSeq"> {
  ts?: number;
  status?: P2pOrderRecordStatus;
  orderSeq?: number;
}

export function p2pOrderRecord(a: P2pOrderRecordInput): P2pOrderRecord {
  const record: P2pOrderRecord = {
    type: P2P_ORDER_TYPE,
    from: a.from,
    to: a.to,
    status: a.status ?? "OPEN",
    orderSeq: a.orderSeq ?? 0,
    ts: a.ts ?? Date.now(),
  };
  if (a.giveToken !== undefined) record.giveToken = a.giveToken;
  if (a.giveAmount !== undefined) record.giveAmount = a.giveAmount;
  if (a.giveChain !== undefined) record.giveChain = a.giveChain;
  if (a.wantCurrency !== undefined) record.wantCurrency = a.wantCurrency;
  if (a.wantAmount !== undefined) record.wantAmount = a.wantAmount;
  if (a.wantRail !== undefined) record.wantRail = a.wantRail;
  if (a.validUntil !== undefined) record.validUntil = a.validUntil;
  if (a.enginePubkey !== undefined) record.enginePubkey = a.enginePubkey;
  if (a.side !== undefined) record.side = a.side;
  if (a.buyerReceiveAddress !== undefined) record.buyerReceiveAddress = a.buyerReceiveAddress;
  if (a.minOrder !== undefined) record.minOrder = a.minOrder;
  if (a.maxOrder !== undefined) record.maxOrder = a.maxOrder;
  if (a.timeLimit !== undefined) record.timeLimit = a.timeLimit;
  if (a.remarks !== undefined) record.remarks = a.remarks;
  return record;
}

const MAX_SKEW_MS = 5 * 60 * 1000;
const DECIMAL = /^\d+(\.\d+)?$/;
export const P2P_ORDER_ID_RE = /^ord-[0-9a-f]{16}$/;

const ORDER_FIELDS = ["giveToken", "giveAmount", "giveChain", "wantCurrency", "wantAmount", "wantRail"] as const;

/** Validate one decoded record. Field checks mirror the engine's own rules. */
export function validateP2pOrderRecord(r: Partial<P2pOrderRecord>): { ok: true } | { ok: false; error: string } {
  if (r.type !== P2P_ORDER_TYPE) return { ok: false, error: `invalid type (${String(r.type)})` };
  if (typeof r.from !== "string" || r.from.length === 0) return { ok: false, error: "from required" };
  if (typeof r.to !== "string" || !P2P_ORDER_ID_RE.test(r.to)) return { ok: false, error: "invalid orderId (to)" };
  if (typeof r.status !== "string" || !(P2P_ORDER_RECORD_STATUSES as readonly string[]).includes(r.status)) {
    return { ok: false, error: `invalid status (${P2P_ORDER_RECORD_STATUSES.join("|")})` };
  }
  if (typeof r.orderSeq !== "number" || !Number.isInteger(r.orderSeq) || r.orderSeq < 0 || r.orderSeq > 100) {
    return { ok: false, error: "invalid orderSeq (integer 0..100)" };
  }
  if (r.status === "OPEN" && r.orderSeq !== 0) return { ok: false, error: "OPEN must have orderSeq 0" };
  if (r.status === "CANCELLED" && r.orderSeq < 1) return { ok: false, error: "CANCELLED must have orderSeq >= 1" };
  if (r.status === "OPEN") {
    for (const field of ORDER_FIELDS) {
      const v = r[field];
      if (typeof v !== "string" || !v || v.length > 256) return { ok: false, error: `${field} required (1..256)` };
    }
    for (const field of ["giveAmount", "wantAmount"] as const) {
      if (!DECIMAL.test(String(r[field]))) return { ok: false, error: `invalid ${field} (decimal string)` };
    }
    if (typeof r.validUntil !== "number" || !Number.isInteger(r.validUntil) || r.validUntil <= 0) {
      return { ok: false, error: "invalid validUntil (unix seconds)" };
    }
    if (r.enginePubkey !== undefined && !/^[0-9a-f]{64,6000}$/.test(r.enginePubkey)) {
      return { ok: false, error: "invalid enginePubkey (prefixed PQ pubkey hex)" };
    }
    if (r.side !== undefined && r.side !== "sell" && r.side !== "buy") {
      return { ok: false, error: "invalid side (buy|sell)" };
    }
    if (r.side === "buy") {
      if (typeof r.buyerReceiveAddress !== "string" || !r.buyerReceiveAddress || r.buyerReceiveAddress.length > 128) {
        return { ok: false, error: "buy order requires buyerReceiveAddress (1..128)" };
      }
    } else if (r.buyerReceiveAddress !== undefined) {
      return { ok: false, error: "buyerReceiveAddress only on a buy order" };
    }
    for (const field of ["minOrder", "maxOrder"] as const) {
      const v = r[field];
      if (v !== undefined && !DECIMAL.test(String(v))) return { ok: false, error: `invalid ${field} (decimal string)` };
    }
    if (r.timeLimit !== undefined && (!Number.isInteger(r.timeLimit) || r.timeLimit < 5 || r.timeLimit > 1440)) {
      return { ok: false, error: "invalid timeLimit (minutes 5..1440)" };
    }
    if (r.remarks !== undefined && (typeof r.remarks !== "string" || r.remarks.length > 256)) {
      return { ok: false, error: "invalid remarks (<=256)" };
    }
  } else {
    // A cancel references the order only — it must not carry (or mutate) terms.
    for (const field of [...ORDER_FIELDS, "validUntil", "enginePubkey", "side", "buyerReceiveAddress", "minOrder", "maxOrder", "timeLimit", "remarks"] as const) {
      if (r[field] !== undefined) return { ok: false, error: `${field} not allowed on CANCELLED` };
    }
  }
  if (typeof r.ts !== "number" || r.ts <= 0 || r.ts > Date.now() + MAX_SKEW_MS) {
    return { ok: false, error: "invalid ts" };
  }
  return { ok: true };
}
