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
});
