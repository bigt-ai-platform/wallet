import { describe, it, expect } from "vitest";
import {
  P2P_RELEASE_TYPE,
  p2pReleaseRecord,
  validateP2pReleaseRecord,
} from "../src/index.js";

describe("p2pReleaseRecord", () => {
  const base = () => ({
    from: "did:key:zSeller",
    to: "swap-0123456789abcdef",
    kind: "release" as const,
    escrowTxHash: "ab".repeat(32),
    toAddress: "3Qw1BA2LeSDuNms3eBY68YPZHcnmFnEpfd",
    escrowSig: "deadbeef",
  });

  it("builds a valid record with a default ts", () => {
    const r = p2pReleaseRecord(base());
    expect(r.type).toBe(P2P_RELEASE_TYPE);
    expect(r.ts).toBeGreaterThan(0);
    expect(validateP2pReleaseRecord(r)).toEqual({ ok: true });
  });
});

describe("validateP2pReleaseRecord", () => {
  const good = () => p2pReleaseRecord({
    from: "did:key:zBuyer",
    to: "swap-0123456789abcdef",
    kind: "refund",
    escrowTxHash: "cd".repeat(32),
    toAddress: "3Qw1BA2LeSDuNms3eBY68YPZHcnmFnEpfd",
    escrowSig: "00ff",
  });

  it("accepts both kinds", () => {
    expect(validateP2pReleaseRecord({ ...good(), kind: "release" }).ok).toBe(true);
    expect(validateP2pReleaseRecord({ ...good(), kind: "refund" }).ok).toBe(true);
  });

  it("rejects a wrong type, kind, swapId, tx hash, address or sig", () => {
    expect(validateP2pReleaseRecord({ ...good(), type: "social.p2p-order" as never }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), kind: "cancel" as never }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), to: "ord-0123456789abcdef" }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), escrowTxHash: "ab" }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), toAddress: "0 bad" }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), escrowSig: "" }).ok).toBe(false);
  });

  it("rejects a missing author and a future ts", () => {
    expect(validateP2pReleaseRecord({ ...good(), from: "" }).ok).toBe(false);
    expect(validateP2pReleaseRecord({ ...good(), ts: Date.now() + 10 * 60 * 1000 }).ok).toBe(false);
  });
});
