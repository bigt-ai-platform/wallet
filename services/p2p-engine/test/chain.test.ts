import { describe, it, expect } from "vitest";
import { ECKey } from "bigtangle-ts";
import { HttpChainClient, verifyChainLock, verifyChainPayment, type ChainClient } from "../src/chain.js";
import { escrowAddress } from "../src/escrow.js";

const escrow = escrowAddress([ECKey.createNewKey(), ECKey.createNewKey(), ECKey.createNewKey()], 2);

function client(status: string, address: string, balances: { token: string; amount: string }[] = []): ChainClient {
  return {
    transactionStatus: async () => ({ status, address }),
    balances: async () =>
      balances.map((b) => ({ address, token: b.token, amount: b.amount, confirmed: true, spent: false })),
  };
}

describe("chain evidence", () => {
  it("accepts a CONFIRMED lock that pays the escrow with enough of the token", async () => {
    const res = await verifyChainLock(client("CONFIRMED", escrow, [{ token: "USDT", amount: "100" }]), {
      txHash: "tx",
      escrowAddress: escrow,
      token: "USDT",
      amount: "100",
    });
    expect(res.ok).toBe(true);
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
