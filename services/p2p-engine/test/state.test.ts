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

  it("allows the CNY claim transitions (docs/p2p.md)", () => {
    expect(canTransition("PAYMENT_PENDING", "PAYMENT_CLAIMED")).toBe(true);
    expect(canTransition("PAYMENT_CLAIMED", "PAYMENT_VERIFIED")).toBe(true);
    expect(canTransition("ESCROW_LOCKED", "PAYMENT_CLAIMED")).toBe(false);
    expect(canTransition("PAYMENT_CLAIMED", "ESCROW_RELEASED")).toBe(false);
    // A refund arbitration keeps the status but freezes the swap (server frozen()).
    expect(canTransition("PAYMENT_CLAIMED", "EXPIRED")).toBe(true);
  });

  it("reaches ESCROW_REFUNDED via EXPIRED or a settled CANCELLED", () => {
    expect(canTransition("ESCROW_LOCKED", "ESCROW_REFUNDED")).toBe(false);
    expect(canTransition("EXPIRED", "ESCROW_REFUNDED")).toBe(true);
    // A post-lock cancel settles through the same refund spend — CANCELLED is
    // never the end of escrowed funds (docs/p2p.md §9).
    expect(canTransition("CANCELLED", "ESCROW_REFUNDED")).toBe(true);
    expect(ACTION_STATUS.refund).toBe("ESCROW_REFUNDED");
  });

  it("bars cancel once a payment is asserted or confirmed", () => {
    expect(canTransition("PAYMENT_CLAIMED", "CANCELLED")).toBe(false);
    expect(canTransition("PAYMENT_VERIFIED", "CANCELLED")).toBe(false);
    // Release is the only honest forward path once the fiat is confirmed.
    expect(canTransition("PAYMENT_VERIFIED", "ESCROW_RELEASED")).toBe(true);
  });

  it("terminal states are final except a complete retry from COMPLETED", () => {
    expect(allowedActions("COMPLETED")).toEqual(["complete"]);
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
    expect(allowedActions("ESCROW_REFUNDED")).toEqual([]);
    // CANCELLED may still settle the escrow refund spend.
    expect(allowedActions("CANCELLED")).toEqual(["refund"]);
  });

  it("maps actions to statuses", () => {
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
