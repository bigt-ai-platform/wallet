import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key, pubKeyHashFromPub } from "did";
import { didFromPQKey } from "did/pq";
import { PQKey, Utils } from "bigtangle-ts";
import type { SettlementOutput } from "p2p-protocol";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { ChainClient } from "../src/chain.js";
import {
  checkDidTokenFunds,
  didPubKeyHashHex,
  rawToDecimal,
} from "../src/funds.js";
import { RECEIVE_ADDRESS } from "./address.js";

const seller = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const buyerDid = didFromEd25519Key(buyer);
const sellerHash = Utils.HEX.encode(pubKeyHashFromPub(seller.getPubBytes()));

let clock = 1_700_000_000_000;
let store = new MemSettlementStore();

function signed(key: Ed25519Key, did: string, fields: Record<string, unknown>) {
  const payload = {
    ...fields,
    did,
    nonce: randomBytes(8).toString("hex"),
    timestamp: clock,
  };
  return { ...payload, signature: signPayload(payload, key.getPrivHex()!) };
}

function row(amount: string, decimals: number | undefined = 6): SettlementOutput {
  return {
    address: "unused",
    token: "USDT",
    amount,
    tokenId: "usdt",
    symbol: "USDT",
    name: "Tether",
    decimals,
    spent: false,
    confirmed: true,
  };
}

function fakeChain(rows: SettlementOutput[] | Error, seen?: { hash?: string }): ChainClient {
  return {
    balances: async (hash: string) => {
      if (seen) seen.hash = hash;
      if (rows instanceof Error) throw rows;
      return rows;
    },
    transactionStatus: async () => ({}),
    outputsHistory: async () => [],
    transactionsStatusByAddress: async () => [],
    submitTransaction: async () => undefined,
  } as unknown as ChainClient;
}

/** Balance rows that can change between the post and the match. */
function mutableChain(getRows: () => SettlementOutput[] | Error): ChainClient {
  return {
    balances: async () => {
      const rows = getRows();
      if (rows instanceof Error) throw rows;
      return rows;
    },
    transactionStatus: async () => ({}),
    outputsHistory: async () => [],
    transactionsStatusByAddress: async () => [],
    submitTransaction: async () => undefined,
  } as unknown as ChainClient;
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return signed(seller, sellerDid, {
    type: "limit_sell",
    sellerDid,
    giveToken: "USDT",
    giveAmount: "100",
    giveChain: "L0",
    wantCurrency: "CNY",
    wantAmount: "700",
    wantRail: "wechat",
    validUntil: Math.floor(clock / 1000) + 3600,
    ...overrides,
    requestMethod: "POST",
    requestPath: "/orders",
  });
}

async function app(chain: ChainClient | null, extraEnv: NodeJS.ProcessEnv = {}) {
  return buildApp({
    store,
    env: {
      SETTLEMENT_ENGINE_DID: sellerDid,
      SETTLEMENT_ADMIN_TOKEN: "adm",
      SETTLEMENT_CNY_RAILS: "wechat,alipay,bank",
      ...extraEnv,
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    chain,
    now: () => clock,
    orderTxTries: 1,
    watchState: { height: null, hash: null, lastRunAt: null, lastError: null },
  });
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  store = new MemSettlementStore();
});

describe("did balance key", () => {
  it("derives the classic h160 and the PQ prefixed-pub hash", () => {
    expect(didPubKeyHashHex(sellerDid)).toBe(sellerHash);
    const pq = PQKey.createNew();
    const pqDid = didFromPQKey(pq);
    expect(didPubKeyHashHex(pqDid)).toBe(
      Utils.HEX.encode(Utils.sha256hash160(pq.getPrefixedPublicKeyBytes())),
    );
    expect(didPubKeyHashHex("not-a-did")).toBeNull();
  });

  it("formats raw units exactly", () => {
    expect(rawToDecimal("100000000", 6)).toBe("100");
    expect(rawToDecimal("99500000", 6)).toBe("99.5");
    expect(rawToDecimal("1", 8)).toBe("0.00000001");
    expect(rawToDecimal("0", 6)).toBe("0");
  });
});

describe("checkDidTokenFunds", () => {
  it("reads a sufficient balance for the seller's DID key", async () => {
    const seen: { hash?: string } = {};
    const funds = await checkDidTokenFunds(fakeChain([row("100000000")], seen), {
      did: sellerDid,
      token: "USDT",
      amount: "100",
    });
    expect(seen.hash).toBe(sellerHash);
    expect(funds).toMatchObject({ checked: true, sufficient: true, available: "100" });
  });

  it("flags a positive shortfall and an empty wallet", async () => {
    const short = await checkDidTokenFunds(fakeChain([row("99000000")]), {
      did: sellerDid,
      token: "USDT",
      amount: "100",
    });
    expect(short).toMatchObject({ checked: true, sufficient: false, available: "99" });
    const empty = await checkDidTokenFunds(fakeChain([]), {
      did: sellerDid,
      token: "USDT",
      amount: "100",
    });
    expect(empty).toMatchObject({ checked: true, sufficient: false, available: "0" });
  });

  it("never rejects on an unknown chain or token metadata", async () => {
    const down = await checkDidTokenFunds(fakeChain(new Error("down")), {
      did: sellerDid,
      token: "USDT",
      amount: "100",
    });
    expect(down.checked).toBe(false);
    const noMeta = row("100000000");
    delete (noMeta as { decimals?: number }).decimals;
    const noDecimals = await checkDidTokenFunds(
      fakeChain([noMeta]),
      { did: sellerDid, token: "USDT", amount: "100" },
    );
    expect(noDecimals.checked).toBe(false);
  });
});

describe("order funds gate", () => {
  it("rejects an unfunded sell ad before it is indexed", async () => {
    const a = await app(fakeChain([row("99000000")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId }),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/seller balance insufficient/);
    expect(await store.getOrder(orderId)).toBeNull();
    await a.close();
  });

  it("accepts a funded sell ad", async () => {
    const a = await app(fakeChain([row("100000000")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId }),
    });
    expect(r.statusCode).toBe(201);
    await a.close();
  });

  it("keeps an unfunded ad in warn mode but flags it in the public book", async () => {
    const a = await app(fakeChain([row("1")]), {
      SETTLEMENT_ORDER_FUNDS_CHECK: "warn",
    });
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const created = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId }),
    });
    expect(created.statusCode).toBe(201);
    const book = await a.inject({ method: "GET", url: "/public/orders?status=ACTIVE" });
    expect(book.json().orders[0].funds).toEqual({ checked: true, sufficient: false });
    await a.close();
  });

  it("rejects a match when the token giver is short at match time", async () => {
    let rows: SettlementOutput[] = [row("100000000")];
    const a = await app(mutableChain(() => rows));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const created = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId }),
    });
    expect(created.statusCode).toBe(201);
    // The ad was funded when posted; the seller moves the tokens before a taker
    // matches. The match-time re-check must reject before a swap is created.
    rows = [row("1")];
    clock += 1;
    const match = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid,
        receiveAddress: RECEIVE_ADDRESS,
        requestMethod: "POST",
        requestPath: `/orders/${orderId}/match`,
      }),
    });
    expect(match.statusCode).toBe(409);
    expect(match.json().error).toMatch(/insufficient USDT balance/);
    expect((await store.getOrder(orderId))?.status).toBe("ACTIVE");
    await a.close();
  });

  it("checks the taker as the seller on a buy bid", async () => {
    const a = await app(fakeChain([row("1")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    // The poster is the buyer; posting a bid needs no balance.
    const created = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({
        orderId,
        type: "limit_buy",
        receiveAddress: RECEIVE_ADDRESS,
      }),
    });
    expect(created.statusCode).toBe(201);
    clock += 1;
    // The taker is the token giver (sellerDid on the swap); the engine checks
    // the signer's DID.
    const match = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid,
        requestMethod: "POST",
        requestPath: `/orders/${orderId}/match`,
      }),
    });
    expect(match.statusCode).toBe(409);
    expect(match.json().error).toMatch(/insufficient USDT balance/);
    await a.close();
  });
});
