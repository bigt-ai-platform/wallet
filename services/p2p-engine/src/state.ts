/**
 * P2P swap state machine (docs/p2p.md). The transition table is a superset of
 * the running bigtai engine's, with `ESCROW_REFUNDED` restored and `CANCELLED`
 * reachable through the state machine (never a raw DELETE).
 */
import type { P2pSwapStatus } from "p2p-protocol";
import type { P2pSwapEvent, SwapAction } from "./types.js";

export const VALID_TRANSITIONS: Record<P2pSwapStatus, readonly P2pSwapStatus[]> = {
  MATCHED: ["ESCROW_LOCKED", "CANCELLED", "EXPIRED"],
  ESCROW_LOCKED: ["PAYMENT_PENDING", "EXPIRED", "CANCELLED"],
  // PAYMENT_PENDING is reached by the PayPal payment hint or, on the CNY rails,
  // by the buyer pulling the seller's payment instructions (docs/p2pcny.md §3).
  PAYMENT_PENDING: ["PAYMENT_CLAIMED", "PAYMENT_VERIFIED", "EXPIRED", "CANCELLED"],
  // PAYMENT_CLAIMED is the CNY state: buyer uploaded proof, seller has not
  // confirmed. It leaves via the seller's confirm, an admin dispute resolve
  // (release), or the ordinary timeout/cancel path to a refund.
  PAYMENT_CLAIMED: ["PAYMENT_VERIFIED", "EXPIRED", "CANCELLED"],
  PAYMENT_VERIFIED: ["ESCROW_RELEASED", "CANCELLED"],
  ESCROW_RELEASED: ["COMPLETED"],
  // COMPLETED → COMPLETED exists only for `payout` (PayPal retry) and
  // `complete` (CNY: no fiat payout step — the seller already got the CNY).
  // No other action targets COMPLETED, so nothing can rewind a finished swap.
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["ESCROW_REFUNDED"],
  ESCROW_REFUNDED: [],
  CANCELLED: [],
};

export const ACTION_STATUS: Record<SwapAction, P2pSwapStatus> = {
  escrow_lock: "ESCROW_LOCKED",
  payment_send: "PAYMENT_PENDING",
  verify: "PAYMENT_VERIFIED",
  release: "ESCROW_RELEASED",
  payout: "COMPLETED",
  expire: "EXPIRED",
  refund: "ESCROW_REFUNDED",
  cancel: "CANCELLED",
  instructions: "PAYMENT_PENDING",
  payment_proof: "PAYMENT_CLAIMED",
  payment_confirm: "PAYMENT_VERIFIED",
  complete: "COMPLETED",
};

/** Actions with a dedicated HTTP route (the generic transitions route rejects them). */
export const DEDICATED_ACTIONS: ReadonlySet<string> = new Set(["instructions", "payment_proof", "payment_confirm"]);

export function canTransition(from: P2pSwapStatus, to: P2pSwapStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** The status an action targets, or null for an unknown action. */
export function statusForAction(action: string): P2pSwapStatus | null {
  return (ACTION_STATUS as Record<string, P2pSwapStatus | undefined>)[action] ?? null;
}

/** Actions allowed from a status (for UI / discovery). */
export function allowedActions(status: P2pSwapStatus): SwapAction[] {
  return (Object.keys(ACTION_STATUS) as SwapAction[]).filter((a) => canTransition(status, ACTION_STATUS[a]));
}

/** The current state is the latest event (events are full snapshots). */
export function reduceEvents(events: readonly P2pSwapEvent[]): P2pSwapEvent | null {
  let latest: P2pSwapEvent | null = null;
  for (const e of events) {
    if (!latest || e.seq >= latest.seq) latest = e;
  }
  return latest;
}
