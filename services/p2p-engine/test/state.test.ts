import { describe, it, expect } from "vitest";
import { ACTION_STATUS, allowedActions, canTransition, reduceEvents, statusForAction } from "../src/state.js";
import type { P2pSwapEvent } from "../src/types.js";

describe("p2p settlement state machine", () => {
  it("allows the happy-path transitions", () => {
    expect(canTransition("MATCHED", "ESCROW_LOCKED")).toBe(true);
    expect(canTransition("ESCROW_LOCKED", "PAYMENT_PENDING")).toBe(true);
    expect(canTransition("PAYMENT_PENDING", "PAYMENT_VERIFIED")).toBe(true);
    expect(canTransition("PAYMENT_VERIFIED", "ESCROW_RELEASED")).toBe(true);
    expect(canTransition("ESCROW_RELEASED", "COMPLETED")).toBe(true);
  });

  it("allows the CNY claim transitions (docs/p2pcny.md)", () => {
    expect(canTransition("PAYMENT_PENDING", "PAYMENT_CLAIMED")).toBe(true);
    expect(canTransition("PAYMENT_CLAIMED", "PAYMENT_VERIFIED")).toBe(true);
    expect(canTransition("ESCROW_LOCKED", "PAYMENT_CLAIMED")).toBe(false);
    expect(canTransition("PAYMENT_CLAIMED", "ESCROW_RELEASED")).toBe(false);
    // A refund arbitration keeps the status but freezes the swap (server frozen()).
    expect(canTransition("PAYMENT_CLAIMED", "EXPIRED")).toBe(true);
  });

  it("reaches ESCROW_REFUNDED only via EXPIRED", () => {
    expect(canTransition("ESCROW_LOCKED", "ESCROW_REFUNDED")).toBe(false);
    expect(canTransition("EXPIRED", "ESCROW_REFUNDED")).toBe(true);
    expect(ACTION_STATUS.refund).toBe("ESCROW_REFUNDED");
  });

  it("terminal states are final except a payout retry / complete from COMPLETED", () => {
    expect(allowedActions("COMPLETED")).toEqual(["payout", "complete"]);
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
    for (const s of ["ESCROW_REFUNDED", "CANCELLED"] as const) {
      expect(allowedActions(s)).toEqual([]);
    }
  });

  it("maps actions to statuses", () => {
    expect(statusForAction("verify")).toBe("PAYMENT_VERIFIED");
    expect(statusForAction("payment_proof")).toBe("PAYMENT_CLAIMED");
    expect(statusForAction("payment_confirm")).toBe("PAYMENT_VERIFIED");
    expect(statusForAction("complete")).toBe("COMPLETED");
    expect(statusForAction("nope")).toBeNull();
  });

  it("reduces to the latest event by seq", () => {
    const mk = (seq: number, status: P2pSwapEvent["status"]): P2pSwapEvent => ({
      swapId: "swap-x",
      seq,
      status,
      eventType: "match",
      at: seq,
    });
    expect(reduceEvents([mk(0, "MATCHED"), mk(2, "PAYMENT_PENDING"), mk(1, "ESCROW_LOCKED")])!.status).toBe("PAYMENT_PENDING");
    expect(reduceEvents([])).toBeNull();
  });
});
