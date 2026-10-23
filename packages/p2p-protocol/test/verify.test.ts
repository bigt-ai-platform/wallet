import { describe, it, expect } from "vitest";
import {
  sameAmount,
  validatePaymentVerdict,
  verdictsAgree,
  machineConfirm,
  normalizeAutoReleasePolicy,
  type PaymentVerdict,
  type VerdictExpectation,
} from "../src/verify.js";

const expected: VerdictExpectation = {
  amount: "715",
  remark: "a1b2c3d4e5f6",
  claimedTxId: "4200001234567890",
  paidFrom: 1_700_000_000_000,
  paidTo: 1_700_003_600_000,
};

const sent: PaymentVerdict = {
  side: "buyer",
  observed: "sent",
  txId: "4200001234567890",
  amount: "715.00",
  remark: "a1b2c3d4e5f6",
  paidAt: 1_700_000_300_000,
  evidenceKind: "device_read",
  counterpartyName: "张三",
  captures: ["a".repeat(64)],
};

const received: PaymentVerdict = {
  side: "seller",
  observed: "received",
  txId: "4200001234567890",
  amount: "715",
  remark: "a1b2c3d4e5f6",
  paidAt: 1_700_000_300_500,
  evidenceKind: "device_read",
};

describe("device-side payment verdicts (docs/p2p.md §12)", () => {
  it("compares amounts as money, not strings", () => {
    expect(sameAmount("715", "715.00")).toBe(true);
    expect(sameAmount("715.0", "715.00")).toBe(true);
    expect(sameAmount("715", "715.01")).toBe(false);
    expect(sameAmount("715", undefined)).toBe(false);
    expect(sameAmount("abc", "715")).toBe(false);
  });

  it("accepts the honest sent/received entries", () => {
    expect(validatePaymentVerdict(sent, expected).ok).toBe(true);
    expect(validatePaymentVerdict(received, expected).ok).toBe(true);
  });

  it("fails closed on the four checks (§12: amount, remark, time, id)", () => {
    expect(
      validatePaymentVerdict({ ...sent, amount: "714.99" }, expected).error,
    ).toMatch(/amount/);
    expect(
      validatePaymentVerdict({ ...sent, remark: "deadbeef" }, expected).error,
    ).toMatch(/remark/);
    expect(
      validatePaymentVerdict({ ...sent, remark: undefined }, expected).error,
    ).toMatch(/remark missing/);
    // an old transfer must not be replayed into a later swap
    expect(
      validatePaymentVerdict(
        { ...sent, paidAt: expected.paidFrom - 1 },
        expected,
      ).error,
    ).toMatch(/window/);
    expect(
      validatePaymentVerdict({ ...sent, paidAt: expected.paidTo + 1 }, expected)
        .error,
    ).toMatch(/window/);
    expect(
      validatePaymentVerdict({ ...sent, txId: "not valid!" }, expected).error,
    ).toMatch(/txId/);
  });

  it("requires the bank's public 回单 verification for bank e-receipts", () => {
    const receipt = { ...sent, evidenceKind: "bank_ereceipt" as const };
    expect(validatePaymentVerdict(receipt, expected).error).toMatch(/回单/);
    expect(
      validatePaymentVerdict({ ...receipt, receiptVerified: true }, expected)
        .ok,
    ).toBe(true);
  });

  it("reports a claim/observation 流水号 mismatch without failing the verdict", () => {
    const other = { ...sent, txId: "9900000000000000" };
    const check = validatePaymentVerdict(other, expected);
    expect(check.ok).toBe(true);
    expect(check.claimMismatch).toEqual({
      claimed: "4200001234567890",
      observed: "9900000000000000",
    });
  });

  it("validates a 'nothing in the ledger' verdict as evidence too", () => {
    const none: PaymentVerdict = {
      side: "seller",
      observed: "none",
      evidenceKind: "device_read",
      captures: ["b".repeat(64)],
    };
    expect(validatePaymentVerdict(none, expected).ok).toBe(true);
    expect(
      validatePaymentVerdict({ ...none, captures: ["nope"] }, expected).error,
    ).toMatch(/captures/);
  });

  it("two-sided agreement needs both directions of one transfer", () => {
    expect(verdictsAgree(sent, received)).toBe(true);
    expect(verdictsAgree(received, sent)).toBe(true);
    expect(verdictsAgree(sent, { ...received, txId: "9900000000000000" })).toBe(
      false,
    );
    expect(verdictsAgree(sent, { ...received, amount: "715.01" })).toBe(false);
    expect(verdictsAgree(sent, { ...received, remark: "ffffffffffff" })).toBe(
      false,
    );
    expect(verdictsAgree(sent, sent)).toBe(false);
    expect(verdictsAgree(sent, { ...received, observed: "none" })).toBe(false);
  });

  it("machine confirmation is policy-gated and defaults to off", () => {
    const none: PaymentVerdict = {
      side: "seller",
      observed: "none",
      evidenceKind: "device_read",
    };
    expect(machineConfirm(undefined, [sent, received])).toBeNull();
    expect(machineConfirm("typo", [sent, received])).toBeNull();
    expect(machineConfirm("off", [sent, received])).toBeNull();
    expect(normalizeAutoReleasePolicy(" two_sided ")).toBe("two_sided");
    expect(normalizeAutoReleasePolicy("bogus")).toBe("off");

    // seller_receipt: the seller's own ledger is enough
    expect(machineConfirm("seller_receipt", [received])?.side).toBe("seller");
    expect(machineConfirm("seller_receipt", [sent])).toBeNull();
    expect(machineConfirm("seller_receipt", [none])).toBeNull();

    // two_sided: both ledgers must agree on one 流水号
    expect(machineConfirm("two_sided", [received])).toBeNull();
    expect(machineConfirm("two_sided", [sent, received])?.side).toBe("seller");
    expect(
      machineConfirm("two_sided", [
        sent,
        { ...received, txId: "9900000000000000" },
      ]),
    ).toBeNull();

    // verified_receipt: the bank's public verification settles it alone
    const eReceipt: PaymentVerdict = {
      side: "buyer",
      observed: "sent",
      txId: "4200001234567890",
      amount: "715",
      remark: "a1b2c3d4e5f6",
      evidenceKind: "bank_ereceipt",
      receiptVerified: true,
    };
    // a buyer's self-asserted receiptVerified must never release on its own
    expect(machineConfirm("verified_receipt", [eReceipt])).toBeNull();
    const sellerReceipt: PaymentVerdict = {
      ...eReceipt,
      side: "seller",
      observed: "received",
    };
    expect(
      machineConfirm("verified_receipt", [sellerReceipt])?.evidenceKind,
    ).toBe("bank_ereceipt");
    expect(machineConfirm("verified_receipt", [sent, received])?.side).toBe(
      "seller",
    );
    expect(machineConfirm("verified_receipt", [sent])).toBeNull();
  });
});
