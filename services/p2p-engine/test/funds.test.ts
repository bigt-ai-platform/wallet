import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key, pubKeyHashFromPub, didFromECKey, ECKey as DidECKey, bytesToHex } from "did";
import { didFromPQKey } from "did/pq";
import { PQKey, Utils } from "bigtangle-ts";
import type { SettlementOutput } from "p2p-protocol";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, canonicalJson, signPayload } from "../src/sign.js";
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

/** A BIG balance row as the L0 node returns it (token id `bc`, 6 decimals). */
function bigRow(amount: string): SettlementOutput {
  return {
    address: "unused",
    token: "BIG",
    amount,
    tokenId: "bc",
    name: "BIG",
    decimals: 6,
    spent: false,
    confirmed: true,
  };
}

/** A body with the legacy-EC funds proof: the wallet's real chain key is an
 *  EC address, while the signer is the derived ML-DSA DID (docs/p2p.md §11). */
function withFundsProof(
  signer: Ed25519Key,
  did: string,
  fields: Record<string, unknown>,
  fundsKey: DidECKey,
) {
  const base = {
    ...fields,
    did,
    nonce: randomBytes(8).toString("hex"),
    timestamp: clock,
  };
  const fundsDid = didFromECKey(fundsKey);
  const fundsPayload = { ...base, fundsDid };
  const digest = createHash("sha256")
    .update(canonicalJson(fundsPayload))
    .digest();
  const fundsSignature = bytesToHex(fundsKey.sign(digest).compact);
  const payload = { ...fundsPayload, fundsSignature };
  return { ...payload, signature: signPayload(payload, signer.getPrivHex()!) };
}

/** Balance rows only under `only` — everything else reads as empty. */
function hashChain(
  only: string,
  rows: SettlementOutput[],
  seen?: { hash?: string },
): ChainClient {
  return {
    balances: async (hash: string) => {
      if (seen) seen.hash = hash;
      return hash.toLowerCase() === only.toLowerCase() ? rows : [];
    },
    transactionStatus: async () => ({}),
    outputsHistory: async () => [],
    transactionsStatusByAddress: async () => [],
    submitTransaction: async () => undefined,
  } as unknown as ChainClient;
}

function bigSellFields(orderId: string) {
  return {
    type: "limit_sell",
    sellerDid,
    giveToken: "BIG",
    giveAmount: "1000",
    giveChain: "L0",
    wantCurrency: "CNY",
    wantAmount: "10",
    wantRail: "wechat",
    validUntil: Math.floor(clock / 1000) + 3600,
    orderId,
    requestMethod: "POST",
    requestPath: "/orders",
  };
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

beforeEach(async () => {
  clock = 1_700_000_000_000;
  store = new MemSettlementStore();
  await store.upsertProfile({
    sellerDid,
    method: "wechat",
    accountName: "Zhang San",
    account: "wxid_pay888",
    updatedAt: clock,
  });
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

  it("attaches a late funds hash to an order the chain projector indexed", async () => {
    // The L1-SOCIAL watcher can insert the OPEN record before the signed
    // intake (which carries the funds proof) reaches /orders.
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    await store.createOrder({
      orderId,
      type: "limit_sell",
      sellerDid,
      giveToken: "BIG",
      giveAmount: "1000",
      giveChain: "L0",
      wantCurrency: "CNY",
      wantAmount: "10",
      wantRail: "wechat",
      validUntil: Math.floor(clock / 1000) + 3600,
      status: "ACTIVE",
      signature: "00",
      createdAt: clock,
    });
    const fundsHash = "ab".repeat(20);
    await store.setOrderFundsHash(orderId, fundsHash);
    expect((await store.getOrder(orderId))?.fundsHash).toBe(fundsHash);
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

  it("checks the proven legacy-EC address, not the derived DID key", async () => {
    const fundsKey = DidECKey.createNewKey();
    const fundsHash = bytesToHex(pubKeyHashFromPub(fundsKey.getPubBytes()));
    const seen: { hash?: string } = {};
    // The BIG lives at the EC address only: the DID-derived key reads empty.
    const a = await app(hashChain(fundsHash, [bigRow("1000000000")], seen));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: withFundsProof(seller, sellerDid, bigSellFields(orderId), fundsKey),
    });
    expect(r.statusCode).toBe(201);
    expect(seen.hash).toBe(fundsHash);
    await a.close();
  });

  it("still rejects a BIG sell ad that is unfunded at both keys", async () => {
    // Without a proof the derived DID key is checked and reads empty.
    const fundsKey = DidECKey.createNewKey();
    const fundsHash = bytesToHex(pubKeyHashFromPub(fundsKey.getPubBytes()));
    const a = await app(hashChain(fundsHash, [bigRow("1000000000")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, bigSellFields(orderId)),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/seller balance insufficient: 0 BIG on L0/);
    await a.close();
  });

  it("rejects a tampered funds proof", async () => {
    const fundsKey = DidECKey.createNewKey();
    const fundsHash = bytesToHex(pubKeyHashFromPub(fundsKey.getPubBytes()));
    const a = await app(hashChain(fundsHash, [bigRow("1000000000")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const body = withFundsProof(seller, sellerDid, bigSellFields(orderId), fundsKey);
    // A malicious client can re-sign the main body; the funds proof itself must
    // still verify against the address it names.
    const { signature: _old, ...rest } = body;
    const tampered = { ...rest, fundsSignature: "00".repeat(64) };
    const resigned = { ...tampered, signature: signPayload(tampered, seller.getPrivHex()!) };
    const r = await a.inject({ method: "POST", url: "/orders", payload: resigned });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/invalid funds signature/);
    await a.close();
  });

  it("checks a buy bid taker at its proven legacy-EC address", async () => {
    const fundsKey = DidECKey.createNewKey();
    const fundsHash = bytesToHex(pubKeyHashFromPub(fundsKey.getPubBytes()));
    const seen: { hash?: string } = {};
    // The taker is the seller on a buy bid; BIG sits at its EC address.
    const a = await app(hashChain(fundsHash, [bigRow("1000000000")], seen));
    await store.upsertProfile({
      sellerDid: buyerDid,
      method: "wechat",
      accountName: "Li Si",
      account: "wxid_taker888",
      updatedAt: clock,
    });
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const created = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({
        orderId,
        type: "limit_buy",
        giveToken: "BIG",
        giveAmount: "1000",
        wantAmount: "10",
        receiveAddress: RECEIVE_ADDRESS,
      }),
    });
    expect(created.statusCode).toBe(201);
    clock += 1;
    const match = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: withFundsProof(
        buyer,
        buyerDid,
        {
          buyerDid,
          requestMethod: "POST",
          requestPath: `/orders/${orderId}/match`,
        },
        fundsKey,
      ),
    });
    expect(match.statusCode).toBe(201);
    expect(seen.hash).toBe(fundsHash);
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

  it("hides an expired ACTIVE ad from the public book", async () => {
    const a = await app(fakeChain([row("100000000")]));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const created = await a.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId }),
    });
    expect(created.statusCode).toBe(201);
    clock += 2 * 3600 * 1000;
    const book = await a.inject({ method: "GET", url: "/public/orders?status=ACTIVE" });
    expect(book.json().orders).toEqual([]);
    expect((await store.getOrder(orderId))?.status).toBe("ACTIVE");
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
    // The taker is the token giver/seller on a buy bid; it needs collection
    // details before a match can even be attempted.
    await store.upsertProfile({
      sellerDid: buyerDid,
      method: "wechat",
      accountName: "Li Si",
      account: "wxid_taker888",
      updatedAt: clock,
    });
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
