import { describe, it, expect } from "vitest";
import { ECKey } from "bigtangle-ts";
import { HttpChainClient, confirmedTxToAddress, verifyChainLock, verifyChainPayment, verifyPaymentOutput, type ChainClient } from "../src/chain.js";
import { escrowAddress } from "../src/escrow.js";

const escrow = escrowAddress([ECKey.createNewKey(), ECKey.createNewKey(), ECKey.createNewKey()], 2);

function client(status: string, address: string, balances: { token: string; amount: string }[] = []): ChainClient {
  return {
    transactionStatus: async () => ({ status, address }),
    balances: async () =>
      balances.map((b) => ({ address, token: b.token, amount: b.amount, confirmed: true, spent: false })),
    // verifyChainLock proves the lock from getOutputsHistory (getBalances cannot
    // see a P2SH escrow output), so the fake must expose the locked balance in
    // the raw UTXO shape — token on `tokenId`, amount on `value.value`.
    outputsHistory: async (addr: string) =>
      addr === address
        ? balances.map((b) => ({
            address,
            hashHex: "tx",
            tokenId: b.token,
            value: { value: b.amount, tokenHex: b.token },
            spent: false,
            confirmed: true,
          }))
        : [],
  };
}

describe("chain evidence", () => {
  it("requires a confirmed output from the exact settlement transaction", async () => {
    const chain = client("DROPPED", escrow);
    let hashHex = "old";
    let confirmed = true;
    chain.outputsHistory = async () => [{ address: escrow, hashHex, confirmed, tokenId: "USDT", value: "100", spent: false }];
    const expected = { txHash: "release", toAddress: escrow, token: "USDT", amount: "100" };
    expect((await verifyPaymentOutput(chain, expected)).ok).toBe(false);
    hashHex = "release";
    confirmed = false;
    expect((await verifyPaymentOutput(chain, expected)).ok).toBe(false);
    confirmed = true;
    expect((await verifyPaymentOutput(chain, expected)).ok).toBe(true);
  });

  it("accepts a CONFIRMED lock that pays the escrow with enough of the token", async () => {
    const res = await verifyChainLock(client("CONFIRMED", escrow, [{ token: "USDT", amount: "100" }]), {
      txHash: "tx",
      escrowAddress: escrow,
      token: "USDT",
      amount: "100",
    });
    expect(res.ok).toBe(true);
  });

  it("counts only the lock tx's own outputs, never other deposits at a shared vault address", async () => {
    const chain = client("CONFIRMED", escrow);
    chain.outputsHistory = async () => [
      { address: escrow, hashHex: "other", tokenId: "USDT", value: "100", spent: false, confirmed: true },
      { address: escrow, hashHex: "tx", tokenId: "USDT", value: "1", spent: false, confirmed: true },
    ];
    const res = await verifyChainLock(chain, { txHash: "tx", escrowAddress: escrow, token: "USDT", amount: "100" });
    expect(res.ok).toBe(false);
  });

  it("fails closed on unconfirmed / wrong address / short amount", async () => {
    expect((await verifyChainLock(client("MEMPOOL", escrow), { txHash: "tx", escrowAddress: escrow })).ok).toBe(false);
    expect(
      (await verifyChainLock(client("CONFIRMED", "elsewhere"), { txHash: "tx", escrowAddress: escrow })).ok,
    ).toBe(false);
    const short = await verifyChainLock(client("CONFIRMED", escrow, [{ token: "USDT", amount: "99" }]), {
      txHash: "tx",
      escrowAddress: escrow,
      token: "USDT",
      amount: "100",
    });
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/insufficient/);
  });

  it("fails closed when the node is unreachable", async () => {
    const broken: ChainClient = {
      transactionStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      balances: async () => [],
      outputsHistory: async () => [],
    };
    const res = await verifyChainLock(broken, { txHash: "tx", escrowAddress: escrow });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unreachable/);
  });

  it("verifies a release to the receive address", async () => {
    expect((await verifyChainPayment(client("CONFIRMED", "1Receive"), { txHash: "tx", toAddress: "1Receive" })).ok).toBe(true);
    expect((await verifyChainPayment(client("CONFIRMED", "1Other"), { txHash: "tx", toAddress: "1Receive" })).ok).toBe(false);
  });
});

describe("HttpChainClient.outputsHistory", () => {
  // Java-first: getOutputsHistory ANDs fromaddress (the transaction's SENDER)
  // and toaddress (the receiver); the escrow lock output is escrow-as-receiver,
  // so the address must be sent in the to slot — the from slot queries the
  // seller's address and never matches the lock output.
  it("queries the toaddress slot, not fromaddress", async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return { ok: true, status: 200, json: async () => ({ outputs: [] }) } as Response;
    };
    const http = new HttpChainClient("http://l0", fetchImpl);
    await http.outputsHistory(escrow);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toEqual({
      fromaddress: "",
      toaddress: escrow,
      starttime: null,
      endtime: null,
    });
  });
});

describe("confirmedTxToAddress", () => {
  it("returns the node txid of a CONFIRMED tx paying the address", async () => {
    const c = {
      ...client("CONFIRMED", escrow),
      transactionsStatusByAddress: async () => [
        { txHash: "a".repeat(64), status: "BATCHED" },
        { txHash: "b".repeat(64), status: "CONFIRMED" },
      ],
    } as ChainClient;
    expect(await confirmedTxToAddress(c, escrow, "b".repeat(64))).toBe("b".repeat(64));
    expect(await confirmedTxToAddress(c, escrow, "a".repeat(64))).toBeNull();
    expect(await confirmedTxToAddress(c, escrow, "c".repeat(64))).toBeNull();
  });

  it("returns null when nothing is confirmed or the query fails (never throws)", async () => {
    const none = { ...client("CONFIRMED", escrow), transactionsStatusByAddress: async () => [] } as ChainClient;
    expect(await confirmedTxToAddress(none, escrow, "b".repeat(64))).toBeNull();
    const down = {
      ...client("CONFIRMED", escrow),
      transactionsStatusByAddress: async () => {
        throw new Error("L0 down");
      },
    } as ChainClient;
    expect(await confirmedTxToAddress(down, escrow, "b".repeat(64))).toBeNull();
  });
});
