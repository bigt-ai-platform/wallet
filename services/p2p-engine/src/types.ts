/**
 * P2P settlement engine types (docs/p2p.md).
 *
 * The swap is an append-only event log: every event carries a full snapshot of
 * the swap (fields carry forward), so the current state is simply the latest
 * event and a replay is deterministic. Amounts are decimal strings so no float
 * rounding can make a settlement check pass or fail by accident.
 */
import type { P2pSwapStatus } from "p2p-protocol";

export type { P2pSwapStatus };

/** Fiat rails the engine can originate/settle. PayPal is the built one; the
 *  CNY rails (docs/p2pcny.md) settle peer-to-peer: buyer → seller directly,
 *  with the seller confirming receipt instead of a rail webhook. */
export type PaymentRail = "paypal" | "wechat" | "alipay" | "bank";

/** Peer-to-peer CNY collection methods (WeChat Pay / Alipay / bank transfer). */
export const CNY_RAILS = ["wechat", "alipay", "bank"] as const;
export type CnyRail = (typeof CNY_RAILS)[number];

export function isCnyRail(rail: string | undefined): rail is CnyRail {
  return (CNY_RAILS as readonly string[]).includes(rail ?? "");
}

export interface P2pOrderInput {
  type: "limit_sell";
  sellerDid: string;
  giveToken: string;
  giveAmount: string;
  giveChain: string;
  wantCurrency: string;
  wantAmount: string;
  wantRail: string;
  /** unix seconds after which the order can no longer be matched */
  validUntil: number;
}

export interface P2pOrder extends Omit<P2pOrderInput, "validUntil"> {
  orderId: string;
  validUntil: number;
  status: "ACTIVE" | "MATCHED" | "CANCELLED";
  /** seller's Ed25519 signature over the canonical order payload */
  signature: string;
  swapId?: string;
  createdAt: number;
}

export const SWAP_ACTIONS = [
  "escrow_lock",
  "payment_send",
  "verify",
  "release",
  "payout",
  "expire",
  "refund",
  "cancel",
  // CNY rails (docs/p2pcny.md) — driven by the dedicated routes, but they are
  // first-class actions so the transition table stays the single source of truth.
  "instructions",
  "payment_proof",
  "payment_confirm",
  "complete",
] as const;
export type SwapAction = (typeof SWAP_ACTIONS)[number];

export type SwapEventType =
  | SwapAction
  | "match"
  | "invoice"
  | "payout_poll"
  | "paypal_webhook"
  | "dispute_open"
  | "dispute_resolve";

/** One append-only swap event; a full snapshot of the swap after the event. */
export interface P2pSwapEvent {
  swapId: string;
  /** monotonic 0-based per-swap sequence */
  seq: number;
  status: P2pSwapStatus;
  eventType: SwapEventType;
  actorDid?: string;
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
  /** Fiat-leg evidence (engine store only — PII and PayPal internals never
   *  anchor on chain; each is re-derivable from PayPal by invoice_number /
   *  payout_batch_id on a rebuild). */
  buyerEmail?: string;
  invoiceId?: string;
  invoiceUrl?: string;
  payoutItemId?: string;
  /** PayPal payout item/batch status once observed (PENDING until then). */
  payoutStatus?: string;
  /** `INVOICING` capture clawed back — freeze the swap (webhook). */
  paymentReversed?: boolean;
  /** CUSTOMER.DISPUTE state (OPEN/UPDATED blocks progress; RESOLVED clears). */
  dispute?: string;
  /** CNY-rail dispute reason (buyer/seller supplied; store-only, never anchored). */
  disputeReason?: string;
  /** Admin arbitration outcome once RESOLVED: "refund" keeps the forward path frozen. */
  disputeOutcome?: "release" | "refund";
  /** CNY rails: per-swap remark code the buyer must include in the transfer. */
  remark?: string;
  /** CNY rails: sha256 of the buyer's uploaded receipt (store + anchor; never the image). */
  receiptSha256?: string;
  /** CNY rails: when the buyer claims they paid (unix ms). */
  paidAt?: number;
  /** match-only, kept in the engine store but never anchored on chain. */
  receiveAddress?: string;
  paypalAccount?: string;
  /** on-chain audit anchor txid, when the event was anchored */
  txid?: string;
  at: number;
}

/** Public-safe projection (PayPal account / receive address / buyer PII redacted). */
export type P2pSwapView = Omit<P2pSwapEvent, "paypalAccount" | "receiveAddress" | "buyerEmail">;

/** Seller's CNY collection profile — PII: engine store + instruction reveals only, never anchored. */
export interface PaymentProfile {
  sellerDid: string;
  method: CnyRail;
  /** 实名 account name (户名 for bank transfers). */
  accountName: string;
  /** Alipay/WeChat account (id or phone) or bank card number. */
  account: string;
  bankName?: string;
  /** Optional collection QR image (data URL) shown to the matched buyer. */
  qr?: string;
  updatedAt: number;
}

/** The buyer's claim that they paid — receipt bytes live here (store-only), never on the swap event. */
export interface PaymentProof {
  swapId: string;
  /** WeChat/Alipay/bank transaction id (流水号). */
  txId: string;
  remark?: string;
  receiptSha256?: string;
  receipt?: string;
  paidAt?: number;
  createdAt: number;
}
