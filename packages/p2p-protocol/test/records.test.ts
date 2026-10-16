import { describe, it, expect } from "vitest";
import { P2P_SWAP_TYPE, p2pSwapRecord, validateP2pSwapRecord } from "../src/index.js";

describe("p2pSwapRecord", () => {
  it("builds the canonical record with type and monotonic seq", () => {
    const r = p2pSwapRecord({
      from: "did:key:zEngine",
      to: "swap-0123456789abcdef",
      status: "ESCROW_LOCKED",
      swapSeq: 1,
      sellerDid: "did:key:zSeller",
      buyerDid: "did:key:zBuyer",
      giveToken: "bc",
      giveAmount: "10.5",
      wantAmount: "101.00",
      escrowAddress: "1EscrowAddr",
      escrowTxHash: "abcd",
    });
    expect(r.type).toBe(P2P_SWAP_TYPE);
    expect(r.ts).toBeGreaterThan(0);
    expect(validateP2pSwapRecord(r)).toEqual({ ok: true });
  });

  it("omits unset optional fields", () => {
    const r = p2pSwapRecord({ from: "did:key:z1", to: "swap-x", status: "MATCHED", swapSeq: 0 });
    expect(r).not.toHaveProperty("escrowAddress");
    expect(Object.keys(r).sort()).toEqual(["from", "status", "swapSeq", "to", "ts", "type"].sort());
  });
});

describe("device verdict fields on the record (docs/p2p.md §12)", () => {
  const base = () => p2pSwapRecord({ from: "did:key:z1", to: "swap-x", status: "PAYMENT_CLAIMED", swapSeq: 2 });

  it("anchors the small evidence and validates it", () => {
    const r = p2pSwapRecord({
      ...base(),
      verifySide: "buyer",
      verifyObserved: "sent",
      verifyTxId: "4200001234567890",
      verifyAmount: "715.00",
      verifyRemark: "p2p-9f3a",
      verifyPaidAt: 1_700_000_000_000,
      verifyEvidence: "device_read",
      verifyCaptures: `${"a".repeat(64)},${"b".repeat(64)}`,
    });
    expect(validateP2pSwapRecord(r)).toEqual({ ok: true });
    expect(r.verifySide).toBe("buyer");
    // the anchored block has no slot for PII — only fields and hashes
    expect(r).not.toHaveProperty("counterpartyName");
  });

  it("rejects malformed verdict fields", () => {
    expect(validateP2pSwapRecord({ ...base(), verifySide: "payer" as never }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyObserved: "maybe" as never }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyEvidence: "screenshot" as never }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyTxId: "not valid!" }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyAmount: "715.0.0" }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyRemark: "" }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyCaptures: "nope" }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyReceipt: "yes" as never }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), verifyPaidAt: -1 }).ok).toBe(false);
  });

  it("omits the verify block entirely when there is no verdict", () => {
    const r = base();
    expect(Object.keys(r).some((k) => k.startsWith("verify"))).toBe(false);
    expect(validateP2pSwapRecord(r)).toEqual({ ok: true });
  });
});

describe("validateP2pSwapRecord", () => {
  const base = () => p2pSwapRecord({ from: "did:key:z1", to: "swap-x", status: "MATCHED", swapSeq: 0 });

  it("rejects a bad status", () => {
    expect(validateP2pSwapRecord({ ...base(), status: "NOPE" as never }).ok).toBe(false);
  });

  it("rejects a non-integer swapSeq", () => {
    expect(validateP2pSwapRecord({ ...base(), swapSeq: 1.5 }).ok).toBe(false);
  });

  it("rejects an amount that is not a decimal string", () => {
    expect(validateP2pSwapRecord({ ...base(), giveAmount: "1e3" }).ok).toBe(false);
    expect(validateP2pSwapRecord({ ...base(), giveAmount: "10.5" }).ok).toBe(true);
  });

  it("rejects a bad type", () => {
    expect(validateP2pSwapRecord({ ...base(), type: "social.other" as never }).ok).toBe(false);
  });

  it("accepts a pinned enginePubkey and rejects a malformed one", () => {
    const pub = "05" + "ab".repeat(2600);
    expect(validateP2pSwapRecord({ ...base(), enginePubkey: pub })).toEqual({ ok: true });
    expect(validateP2pSwapRecord({ ...base(), enginePubkey: "xyz" }).ok).toBe(false);
  });
});
