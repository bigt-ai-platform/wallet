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

/** Fiat rails the engine can originate/settle. PayPal is the built one. */
export type PaymentRail = "paypal";

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
] as const;
export type SwapAction = (typeof SWAP_ACTIONS)[number];

export type SwapEventType = SwapAction | "match" | "invoice" | "payout_poll" | "paypal_webhook";

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
  /** match-only, kept in the engine store but never anchored on chain. */
  receiveAddress?: string;
  paypalAccount?: string;
  /** on-chain audit anchor txid, when the event was anchored */
  txid?: string;
  at: number;
}

/** Public-safe projection (PayPal account / receive address / buyer PII redacted). */
export type P2pSwapView = Omit<P2pSwapEvent, "paypalAccount" | "receiveAddress" | "buyerEmail">;
