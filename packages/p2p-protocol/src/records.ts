/**
 * `social.p2p-swap` — the P2P settlement audit record.
 *
 * This type is owned entirely by the wallet: it is emitted by the p2p-engine,
 * anchored on the L1-SOCIAL chain (any `social.*` type is accepted by the
 * social server's ingestion gate), and validated/projected by the wallet's own
 * rebuild watcher. No other repo needs to know it.
 *
 * The record is append-only: every verified state transition writes one record,
 * `swapSeq` orders events per swap so the log replays deterministically, and
 * `to` is the opaque `swapId`. Amounts are decimal strings so no float rounding
 * can change a settlement check.
 */

export const P2P_SWAP_TYPE = "social.p2p-swap";

/** Swap lifecycle. Pre-release states may move to EXPIRED → ESCROW_REFUNDED, or CANCELLED.
 *  PAYMENT_CLAIMED is the CNY-rail state (docs/p2pcny.md): the buyer uploaded a
 *  payment proof and the seller has not yet confirmed receipt. */
export const P2P_SWAP_STATUSES = [
  "MATCHED",
  "ESCROW_LOCKED",
  "PAYMENT_PENDING",
  "PAYMENT_CLAIMED",
  "PAYMENT_VERIFIED",
  "ESCROW_RELEASED",
  "COMPLETED",
  "EXPIRED",
  "ESCROW_REFUNDED",
  "CANCELLED",
] as const;
export type P2pSwapStatus = (typeof P2P_SWAP_STATUSES)[number];

export interface P2pSwapRecord {
  type: typeof P2P_SWAP_TYPE;
  /** did:key of the anchoring party (the engine). */
  from: string;
  /** the opaque swapId. */
  to: string;
  ts: number;
  status: P2pSwapStatus;
  /** monotonic per-swap event sequence (0-based). */
  swapSeq: number;
  orderId?: string;
  sellerDid?: string;
  buyerDid?: string;
  giveChain?: string;
  giveToken?: string;
  giveAmount?: string;
  wantAmount?: string;
  wantRail?: string;
  wantCurrency?: string;
  escrowAddress?: string;
  escrowTxHash?: string;
  releaseTxHash?: string;
  paymentRail?: string;
  paymentRef?: string;
  payoutRef?: string;
  /** CNY rails: sha256 of the buyer's receipt evidence (docs/p2pcny.md) — a
   *  hash only, so the image itself never reaches the chain. */
  receiptSha256?: string;
}

export interface P2pSwapRecordInput extends Omit<P2pSwapRecord, "type" | "ts"> {
  ts?: number;
}

export function p2pSwapRecord(a: P2pSwapRecordInput): P2pSwapRecord {
  const record: P2pSwapRecord = {
    type: P2P_SWAP_TYPE,
    from: a.from,
    to: a.to,
    status: a.status,
    swapSeq: a.swapSeq,
    ts: a.ts ?? Date.now(),
  };
  if (a.orderId !== undefined) record.orderId = a.orderId;
  if (a.sellerDid !== undefined) record.sellerDid = a.sellerDid;
  if (a.buyerDid !== undefined) record.buyerDid = a.buyerDid;
  if (a.giveChain !== undefined) record.giveChain = a.giveChain;
  if (a.giveToken !== undefined) record.giveToken = a.giveToken;
  if (a.giveAmount !== undefined) record.giveAmount = a.giveAmount;
  if (a.wantAmount !== undefined) record.wantAmount = a.wantAmount;
  if (a.wantRail !== undefined) record.wantRail = a.wantRail;
  if (a.wantCurrency !== undefined) record.wantCurrency = a.wantCurrency;
  if (a.escrowAddress !== undefined) record.escrowAddress = a.escrowAddress;
  if (a.escrowTxHash !== undefined) record.escrowTxHash = a.escrowTxHash;
  if (a.releaseTxHash !== undefined) record.releaseTxHash = a.releaseTxHash;
  if (a.paymentRail !== undefined) record.paymentRail = a.paymentRail;
  if (a.paymentRef !== undefined) record.paymentRef = a.paymentRef;
  if (a.payoutRef !== undefined) record.payoutRef = a.payoutRef;
  if (a.receiptSha256 !== undefined) record.receiptSha256 = a.receiptSha256;
  return record;
}

const MAX_SKEW_MS = 5 * 60 * 1000;
const DECIMAL = /^\d+(\.\d+)?$/;

/** Validate one decoded record. Field checks mirror the engine's own rules. */
export function validateP2pSwapRecord(r: Partial<P2pSwapRecord>): { ok: true } | { ok: false; error: string } {
  if (r.type !== P2P_SWAP_TYPE) return { ok: false, error: `invalid type (${String(r.type)})` };
  if (typeof r.from !== "string" || r.from.length === 0) return { ok: false, error: "from required" };
  if (typeof r.to !== "string" || r.to.length === 0) return { ok: false, error: "to required" };
  if (typeof r.status !== "string" || !(P2P_SWAP_STATUSES as readonly string[]).includes(r.status)) {
    return { ok: false, error: `invalid status (${P2P_SWAP_STATUSES.join("|")})` };
  }
  if (typeof r.swapSeq !== "number" || !Number.isInteger(r.swapSeq) || r.swapSeq < 0 || r.swapSeq > 1_000_000) {
    return { ok: false, error: "invalid swapSeq (integer 0..1000000)" };
  }
  for (const field of [
    "orderId",
    "giveChain",
    "giveToken",
    "wantRail",
    "wantCurrency",
    "escrowAddress",
    "escrowTxHash",
    "releaseTxHash",
    "paymentRail",
    "paymentRef",
    "payoutRef",
  ] as const) {
    const v = r[field];
    if (v !== undefined && (typeof v !== "string" || v.length === 0 || v.length > 256)) {
      return { ok: false, error: `invalid ${field} (1..256)` };
    }
  }
  for (const field of ["giveAmount", "wantAmount"] as const) {
    const v = r[field];
    if (v !== undefined && (typeof v !== "string" || !DECIMAL.test(v))) {
      return { ok: false, error: `invalid ${field} (decimal string)` };
    }
  }
  if (r.receiptSha256 !== undefined && !/^[0-9a-f]{64}$/.test(r.receiptSha256)) {
    return { ok: false, error: "invalid receiptSha256 (sha256 hex)" };
  }
  if (typeof r.ts !== "number" || r.ts <= 0 || r.ts > Date.now() + MAX_SKEW_MS) {
    return { ok: false, error: "invalid ts" };
  }
  return { ok: true };
}
