/**
 * P2P settlement engine types (docs/p2p.md).
 *
 * The swap is an append-only event log: every event carries a full snapshot of
 * the swap (fields carry forward), so the current state is simply the latest
 * event and a replay is deterministic. Amounts are decimal strings so no float
 * rounding can make a settlement check pass or fail by accident.
 */
import type { P2pSwapStatus, PairingGrant, PaymentVerdict, VerifyEvidenceKind } from "p2p-protocol";

export type { P2pSwapStatus };
export type { PairingGrant, PaymentVerdict, VerifyEvidenceKind };

/** Peer-to-peer CNY collection methods (WeChat Pay / Alipay / bank transfer). */
export type PaymentRail = "wechat" | "alipay" | "bank";

/** Peer-to-peer CNY collection methods (WeChat Pay / Alipay / bank transfer). */
export const CNY_RAILS = ["wechat", "alipay", "bank"] as const;
export type CnyRail = (typeof CNY_RAILS)[number];

export function isCnyRail(rail: string | undefined): rail is CnyRail {
  return (CNY_RAILS as readonly string[]).includes(rail ?? "");
}

export type P2pOrderType = "limit_sell" | "limit_buy";

export interface P2pOrderInput {
  type: P2pOrderType;
  /**
   * The order's **poster** (author). For a `limit_sell` this is the seller (the
   * token giver); for a `limit_buy` it is the buyer (the fiat payer) — the
   * engine maps roles onto the swap at match time.
   */
  sellerDid: string;
  giveToken: string;
  giveAmount: string;
  giveChain: string;
  wantCurrency: string;
  wantAmount: string;
  wantRail: string;
  /** unix seconds after which the order can no longer be matched */
  validUntil: number;
  /** A `limit_buy` bid carries where the poster (buyer) wants the tokens sent. */
  buyerReceiveAddress?: string;
  /** Per-order fiat limit (Binance-style), bounded by the total. */
  minOrder?: string;
  maxOrder?: string;
  /** Payment window in minutes the buyer is given (Binance: 15..180). */
  timeLimit?: number;
  /** Free-text ad terms shown to the counterparty. */
  remarks?: string;
}

export interface P2pOrder extends Omit<P2pOrderInput, "validUntil"> {
  orderId: string;
  validUntil: number;
  status: "ACTIVE" | "MATCHED" | "CANCELLED";
  /** poster's Ed25519 signature over the canonical order payload */
  signature: string;
  swapId?: string;
  /** L1-SOCIAL txid of the seller-anchored `social.p2p-order` record, when on-chain */
  txid?: string;
  /**
   * The engine escrow participant the order is pinned to (docs/p2p.md §26):
   * the match derives the escrow address from this key, so an order can only be
   * matched by a deployment that holds it. Absent on legacy engine-intake
   * orders (they fall back to the current key).
   */
  enginePubkey?: string;
  /** Crypto remaining after partial fills (absent → the full `giveAmount`).
   *  Store-only: the projector rebuilds it from the anchored match swaps. */
  remainingGive?: string;
  createdAt: number;
}

export const SWAP_ACTIONS = [
  "escrow_lock",
  "release",
  "expire",
  "refund",
  "cancel",
  // CNY rails (docs/p2p.md) — driven by the dedicated routes, but they are
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
  | "dispute_open"
  | "dispute_resolve"
  /** Device-side payment verdict (§12) — the anchor-safe evidence snapshot. */
  | "payment_verify";

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
  /** On-chain refund spend that returned the escrow to the seller. */
  refundTxHash?: string;
  /**
   * The engine escrow participant this swap was created against
   * (docs/p2p.md §26), pinned at match so the wallet derives the 2-of-3 vault
   * without `GET /capabilities` and a later key rotation cannot silently
   * re-point an in-flight swap. Public (it is in the on-chain redeem script).
   */
  enginePubkey?: string;
  /** Buyer's payment window in seconds, from the ad's timeLimit (docs/p2p.md):
   *  sets the instructions' `payBy`. Absent → the engine's env default. */
  payWindowSec?: number;
  /** CUSTOMER.DISPUTE state (OPEN/UPDATED blocks progress; RESOLVED clears). */
  dispute?: string;
  /** CNY-rail dispute reason (buyer/seller supplied; store-only, never anchored). */
  disputeReason?: string;
  /** Admin arbitration outcome once RESOLVED: "refund" keeps the forward path frozen. */
  disputeOutcome?: "release" | "refund";
  /** When a device-verified verdict acted as the confirm (§12): how it was obtained. */
  verifySource?: VerifyEvidenceKind;
  /**
   * The anchored device verdict (§12) on `payment_verify` events — the
   * anchor-safe subset: fields + capture hashes, never the counterparty name
   * (PII stays in `p2p_payment_verifications`) and never capture bytes.
   */
  verify?: Omit<PaymentVerdict, "counterpartyName">;
  /** CNY rails: per-swap remark code the buyer must include in the transfer. */
  remark?: string;
  /** CNY rails: sha256 of the buyer's uploaded receipt (store + anchor; never the image). */
  receiptSha256?: string;
  /** CNY rails: when the buyer claims they paid (unix ms). */
  paidAt?: number;
  /** match-only, kept in the engine store but never anchored on chain. */
  receiveAddress?: string;
  /** on-chain audit anchor txid, when the event was anchored */
  txid?: string;
  at: number;
}

/** Public-safe projection (receive address redacted). */
export type P2pSwapView = Omit<P2pSwapEvent, "receiveAddress"> & {
  /** Seller pre-signed both spend skeletons (the escrow hook is armed). Party-scoped reads only. */
  presigned?: boolean;
};

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

/**
 * A device-side verification verdict (docs/p2p.md §12): a party's agent read
 * the matching entry in their own rail app and their wallet signed what it saw.
 * Store-only evidence (§14) — the counterparty name and capture refs never
 * reach the chain. What a verdict may change is policy-gated (`machineConfirm`).
 */
export interface PaymentVerification extends PaymentVerdict {
  swapId: string;
  /** Whose key signed the verdict — the owner of the ledger that was read. */
  did: string;
  createdAt: number;
}

/**
 * A stored device pairing (docs/p2p.md §12): a DID-signed grant letting the
 * engine drive one mobile-mcp endpoint a user paired. Consent record —
 * store-only (the endpoint URL is a user's machine address), and the signature
 * over it is the engine's ordinary whole-body DID auth.
 */
export interface StoredPairing extends PairingGrant {
  createdAt: number;
  /** Set when the owner revoked the grant; revoked pairings are never used. */
  revoked?: boolean;
}

/**
 * Escrow spend signatures (docs/p2p.md — the settlement closure). The seller's
 * pre-signatures over the two deterministic skeletons (release pays
 * `receiveAddress`, refund pays `refundAddress`; both spend the same escrow
 * UTXO for the same amount), so the engine can finish a swap without either
 * party online. Store-only: nothing here is anchored, and the row doubles as
 * the engine's submitted-tx record for restart recovery.
 */
export interface EscrowSigning {
  swapId: string;
  /** Where a refund pays — chosen by the seller at presign time. */
  refundAddress: string;
  /** Hex SignatureBundle over the release skeleton, '' until signed. */
  releaseSig: string;
  /** Hex SignatureBundle over the refund skeleton, '' until signed. */
  refundSig: string;
  /** Whose signature each blob is (seller presign or a party cosign). */
  releaseSignerDid: string;
  refundSignerDid: string;
  sellerDid: string;
  /** Submitted release tx (persisted before confirmation, for recovery). */
  releaseTxHash?: string | null;
  /** Submitted refund tx (persisted before confirmation, for recovery). */
  refundTxHash?: string | null;
  createdAt: number;
  updatedAt: number;
}
