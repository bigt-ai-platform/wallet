import { describe, it, expect } from "vitest";
import { Address, ECKey, MainNetParams, TestParams } from "bigtangle-ts";
import { escrowAddress, escrowRedeemScript, settlementParams } from "../src/escrow.js";

const a = ECKey.createNewKey();
const b = ECKey.createNewKey();
const c = ECKey.createNewKey();

describe("2-of-3 P2SH escrow", () => {
  it("derives a deterministic P2SH address, independent of key order", () => {
    const addr = escrowAddress([a, b, c], 2);
    expect(addr).toBe(escrowAddress([c, a, b], 2));
    const parsed = Address.fromBase58(MainNetParams.get(), addr);
    expect(parsed.isP2SHAddress()).toBe(true);
  });

  it("changes with the key set", () => {
    expect(escrowAddress([a, b, c], 2)).not.toBe(escrowAddress([a, b, ECKey.createNewKey()], 2));
  });

  it("sorts the redeem script keys for all parties", () => {
    const s1 = Buffer.from(escrowRedeemScript(2, [a, b, c]).getProgram()).toString("hex");
    const s2 = Buffer.from(escrowRedeemScript(2, [c, b, a]).getProgram()).toString("hex");
    expect(s1).toBe(s2);
  });
});

describe("settlement network params", () => {
  it("defaults to mainnet and only flips on an explicit testnet switch", () => {
    expect(settlementParams({}).getId()).toBe(MainNetParams.get().getId());
    expect(settlementParams({ SETTLEMENT_NETWORK: "mainnet" }).getId()).toBe(MainNetParams.get().getId());
    expect(settlementParams({ SETTLEMENT_TESTNET: "1" }).getId()).toBe(TestParams.get().getId());
    expect(settlementParams({ SETTLEMENT_NETWORK: "testnet" }).getId()).toBe(TestParams.get().getId());
  });

  it("derives the P2SH address under the selected network", () => {
    const main = escrowAddress([a, b, c], 2, MainNetParams.get());
    const test = escrowAddress([a, b, c], 2, TestParams.get());
    expect(test).not.toBe(main);
    expect(Address.fromBase58(TestParams.get(), test).isP2SHAddress()).toBe(true);
    // same redeem script / h160 — only the base58 version byte differs
    expect(Address.fromBase58(TestParams.get(), test).getHash160())
      .toEqual(Address.fromBase58(MainNetParams.get(), main).getHash160());
  });
});
