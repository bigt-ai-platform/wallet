import { describe, it, expect } from "vitest";
import { P2P_ORDER_TYPE, p2pOrderRecord, validateP2pOrderRecord } from "../src/index.js";

describe("p2pOrderRecord", () => {
  const base = () => ({
    from: "did:key:zSeller",
    to: "ord-0123456789abcdef",
    giveToken: "bc",
    giveAmount: "10.5",
    giveChain: "L0",
    wantCurrency: "CNY",
    wantAmount: "715",
    wantRail: "wechat",
    validUntil: 1_800_000_000,
  });

  it("builds the canonical OPEN record with defaults", () => {
    const r = p2pOrderRecord(base());
    expect(r.type).toBe(P2P_ORDER_TYPE);
    expect(r.status).toBe("OPEN");
    expect(r.orderSeq).toBe(0);
    expect(r.ts).toBeGreaterThan(0);
    expect(validateP2pOrderRecord(r)).toEqual({ ok: true });
  });

  it("omits unset optional fields", () => {
    const r = p2pOrderRecord({ from: "did:key:z1", to: "ord-0123456789abcdef" });
    expect(r.status).toBe("OPEN");
    expect(validateP2pOrderRecord(r).ok).toBe(false); // OPEN needs terms
    expect(Object.keys(r).sort()).toEqual(["from", "orderSeq", "status", "to", "ts", "type"].sort());
  });
});

describe("validateP2pOrderRecord", () => {
  const open = () =>
    p2pOrderRecord({
      from: "did:key:zSeller",
      to: "ord-0123456789abcdef",
      giveToken: "bc",
      giveAmount: "10.5",
      giveChain: "L0",
      wantCurrency: "CNY",
      wantAmount: "715",
      wantRail: "wechat",
      validUntil: 1_800_000_000,
    });

  it("rejects a bad type / bad orderId", () => {
    expect(validateP2pOrderRecord({ ...open(), type: "social.other" as never }).ok).toBe(false);
    expect(validateP2pOrderRecord({ ...open(), to: "swap-01" }).ok).toBe(false);
  });

  it("requires all terms on OPEN", () => {
    const { giveToken: _g, ...noToken } = open();
    expect(validateP2pOrderRecord(noToken as never).ok).toBe(false);
    expect(validateP2pOrderRecord({ ...open(), validUntil: 0 as never }).ok).toBe(false);
  });

  it("rejects non-decimal amounts and bad rails shapes", () => {
    expect(validateP2pOrderRecord({ ...open(), giveAmount: "1e3" }).ok).toBe(false);
    expect(validateP2pOrderRecord({ ...open(), wantAmount: "-1" }).ok).toBe(false);
  });

  it("accepts a CANCELLED record with no terms and rejects terms on it", () => {
    const cancel = p2pOrderRecord({
      from: "did:key:zSeller",
      to: "ord-0123456789abcdef",
      status: "CANCELLED",
      orderSeq: 1,
    });
    expect(validateP2pOrderRecord(cancel)).toEqual({ ok: true });
    expect(validateP2pOrderRecord({ ...cancel, giveToken: "bc" }).ok).toBe(false);
    expect(validateP2pOrderRecord({ ...cancel, orderSeq: 0 }).ok).toBe(false);
  });

  it("rejects a future-skewed ts and a bogus orderSeq", () => {
    expect(validateP2pOrderRecord({ ...open(), ts: Date.now() + 10 * 60 * 1000 }).ok).toBe(false);
    expect(validateP2pOrderRecord({ ...open(), orderSeq: -1 }).ok).toBe(false);
  });

  it("pins an optional enginePubkey on OPEN and rejects it on CANCELLED", () => {
    const pub = "05" + "ab".repeat(2600); // prefixed PQ pubkey hex length class
    expect(validateP2pOrderRecord({ ...open(), enginePubkey: pub })).toEqual({ ok: true });
    expect(validateP2pOrderRecord({ ...open(), enginePubkey: "not-hex" }).ok).toBe(false);
    const cancel = p2pOrderRecord({
      from: "did:key:zSeller",
      to: "ord-0123456789abcdef",
      status: "CANCELLED",
      orderSeq: 1,
    });
    expect(validateP2pOrderRecord({ ...cancel, enginePubkey: pub }).ok).toBe(false);
  });
});
