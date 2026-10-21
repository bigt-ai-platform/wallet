import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { PQKey, Utils } from "bigtangle-ts";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { BlobSettlementStore } from "../src/storeBlob.js";
import { MemBlobStore } from "../src/blob.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";
import { RECEIVE_ADDRESS } from "./address.js";

const seller = Ed25519Key.createNewKey();
const other = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const otherDid = didFromEd25519Key(other);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);

// A PQ engine identity (the escrow participant) for the pinned-order tests.
const enginePq = PQKey.createNew();
const enginePqPub = Utils.HEX.encode(enginePq.getPrefixedPublicKeyBytes());
const rogueEnginePub = Utils.HEX.encode(PQKey.createNew().getPrefixedPublicKeyBytes());

let clock = 1_700_000_000_000;
let store = new MemSettlementStore();
let txidOk = true;
let anchorThrows = false;
const TXID = "c".repeat(64);

function signed(key: Ed25519Key, did: string, fields: Record<string, unknown>) {
  const payload = { ...fields, did, nonce: randomBytes(8).toString("hex"), timestamp: clock };
  return { ...payload, signature: signPayload(payload, key.getPrivHex()!) };
}

async function app(extraEnv: NodeJS.ProcessEnv = {}) {
  return buildApp({
    store,
    env: {
      SETTLEMENT_ENGINE_DID: engineDid,
      SETTLEMENT_ADMIN_TOKEN: "adm",
      ...extraEnv,
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    chain: null,
    now: () => clock,
    orderTxTries: 1,
    verifyTx: async () => txidOk,
    watchState: { height: null, hash: null, lastRunAt: null, lastError: null },
    anchor: async (e: P2pSwapEvent) => {
      if (anchorThrows) throw new Error("anchor down");
      return { txid: e.swapId.padEnd(64, "0") };
    },
  });
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return signed(seller, sellerDid, {
    type: "limit_sell",
    sellerDid,
    giveToken: "USDT",
    giveAmount: "100",
    giveChain: "L0",
    wantCurrency: "USD",
    wantAmount: "101",
    wantRail: "wechat",
    validUntil: Math.floor(clock / 1000) + 3600,
    ...overrides, requestMethod: "POST", requestPath: "/orders" });
}

beforeEach(() => {
  store = new MemSettlementStore();
  txidOk = true;
  anchorThrows = false;
});

describe("seller-anchored order intake (orderId + L1-SOCIAL txid)", () => {
  it("accepts an order with a confirmed txid and stores it", async () => {
    const a = await app();
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ orderId, status: "ACTIVE", txid: TXID });
    expect((await store.getOrder(orderId))?.txid).toBe(TXID);
  });

  it("rejects with 409 while the txid is not confirmed", async () => {
    const a = await app();
    txidOk = false;
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/txid not confirmed/);
    expect(await store.getOrder(orderId)).toBeNull();
  });

  it("400s a malformed orderId or txid", async () => {
    const a = await app();
    const bad1 = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId: "ord-zzz" }) });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ txid: "nope" }) });
    expect(bad2.statusCode).toBe(400);
  });

  it("is idempotent for the same seller and 409s a colliding orderId", async () => {
    const a = await app();
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const first = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(first.statusCode).toBe(201);
    const again = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ orderId, status: "ACTIVE" });
    clock += 1;
    const clash = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(other, otherDid, {
        type: "limit_sell",
        sellerDid: otherDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "101",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
        orderId, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(clash.statusCode).toBe(409);
  });

  it("keeps the legacy no-txid path working", async () => {
    const a = await app();
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    expect(r.statusCode).toBe(201);
    expect(r.json().txid).toBeNull();
  });
});

describe("POST /orders/:orderId/cancel", () => {
  async function create(a: Awaited<ReturnType<typeof buildApp>>, overrides: Record<string, unknown> = {}) {
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, ...overrides }) });
    expect(r.statusCode).toBe(201);
    return orderId;
  }

  it("cancels an ACTIVE order (with confirmed txid) and is idempotent", async () => {
    const a = await app();
    const orderId = await create(a, { txid: TXID });
    clock += 1;
    const r = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid, txid: "d".repeat(64), requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ orderId, status: "CANCELLED", txid: "d".repeat(64) });
    expect((await store.getOrder(orderId))?.status).toBe("CANCELLED");
    const again = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid, requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("CANCELLED");
  });

  it("409s an unconfirmed cancel txid", async () => {
    const a = await app();
    const orderId = await create(a);
    clock += 1;
    txidOk = false;
    const r = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid, txid: TXID, requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }),
    });
    expect(r.statusCode).toBe(409);
    expect((await store.getOrder(orderId))?.status).toBe("ACTIVE");
  });

  it("404s unknown, 403s a non-seller, 409s a MATCHED order", async () => {
    const a = await app();
    const orderId = await create(a);
    clock += 1;
    const unknown = await a.inject({
      method: "POST",
      url: `/orders/ord-0000000000000000/cancel`,
      payload: signed(seller, sellerDid, { sellerDid, requestMethod: "POST", requestPath: `/orders/ord-0000000000000000/cancel` }),
    });
    expect(unknown.statusCode).toBe(404);
    const stranger = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(other, otherDid, { sellerDid: otherDid, requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }),
    });
    expect(stranger.statusCode).toBe(403);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    clock += 1;
    const afterMatch = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid, requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }),
    });
    expect(afterMatch.statusCode).toBe(409);
  });

  it("400s an invalid orderId in the path", async () => {
    const a = await app();
    const r = await a.inject({ method: "POST", url: "/orders/not-an-id/cancel", payload: signed(seller, sellerDid, { sellerDid, requestMethod: "POST", requestPath: "/orders/not-an-id/cancel" }) });
    expect(r.statusCode).toBe(400);
  });
});

describe("match claim + reopen on anchor failure", () => {
  it.each(["1Receive", "not-an-address", RECEIVE_ADDRESS.slice(0, -1)])("rejects an invalid receive address %s without reserving", async (receiveAddress) => {
    const a = await app();
    const orderId = (await a.inject({ method: "POST", url: "/orders", payload: orderPayload() })).json().orderId;
    const matched = await a.inject({
      method: "POST", url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(matched.statusCode).toBe(400);
    expect(matched.json().error).toMatch(/not a valid address/);
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE" });
    expect(await store.allEvents()).toEqual([]);
    const bid = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ type: "limit_buy", receiveAddress }) });
    expect(bid.statusCode).toBe(400);
    await a.close();
  });
  it("keeps the reservation when the anchor succeeds but event storage fails", async () => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    store.appendEvent = async (_event, prepare) => {
      await prepare?.();
      throw new Error("projection unavailable");
    };
    const matched = await a.inject({
      method: "POST", url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid, fillAmount: "40", receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match`,
      }),
    });
    expect(matched.statusCode).toBe(500);
    expect((await store.getOrder(orderId))?.remainingGive).toBe("60");
    await a.close();
  });

  it.each([
    ["0.3", "0.1", "0.2"],
    ["0.00000003", "0.00000001", "0.00000002"],
    ["9007199254740993", "1", "9007199254740992"],
  ])("keeps %s minus %s exact through the final fill", async (total, fill, remaining) => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ giveAmount: total, wantAmount: total }) });
    expect(created.statusCode).toBe(201);
    const orderId = created.json().orderId;
    for (const fillAmount of [fill, remaining]) {
      const matched = await a.inject({
        method: "POST", url: `/orders/${orderId}/match`,
        payload: signed(buyer, buyerDid, {
          buyerDid, fillAmount, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match`,
        }),
      });
      expect(matched.statusCode).toBe(201);
      expect((await store.getSwap(matched.json().swapId))?.wantAmount).toBe(fillAmount);
      expect((await store.getOrder(orderId))?.remainingGive).toBe(fillAmount === fill ? remaining : "0");
    }
    await a.close();
  });

  it.each([
    [{ giveAmount: "100", wantAmount: "100", minOrder: "30" }, "80", 409, /remaining order/],
    [{ giveAmount: "3", wantAmount: "1" }, "1", 400, /exact fiat/],
  ] as const)("rejects a stranded or inexact fill without reserving quantity", async (terms, fillAmount, status, error) => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload(terms) });
    const orderId = created.json().orderId;
    const matched = await a.inject({
      method: "POST", url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid, fillAmount, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match`,
      }),
    });
    expect(matched.statusCode).toBe(status);
    expect(matched.json().error).toMatch(error);
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE", giveAmount: terms.giveAmount });
    expect(await store.allEvents()).toEqual([]);
    await a.close();
  });

  it("restores reservations once without overwriting other fills or cancellations", async () => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    await store.markOrderMatched(orderId, "swap-first", "60", "100");
    await store.markOrderMatched(orderId, "swap-second", undefined, "60");
    await store.reopenOrder(orderId, "swap-first");
    await store.reopenOrder(orderId, "swap-first");
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE", remainingGive: "40" });
    expect(await store.markOrderMatched(orderId, "swap-first", "20", "40")).toBe(false);
    await store.markOrderCancelled(orderId);
    await store.reopenOrder(orderId, "swap-second");
    expect(await store.getOrder(orderId)).toMatchObject({ status: "CANCELLED", remainingGive: "100" });
    await a.close();
  });

  it.each(["CANCELLED", "EXPIRED"] as const)("restores an unfunded %s swap but waits for a funded refund", async (status) => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    await store.markOrderMatched(orderId, "swap-unfunded", "60", "100");
    await store.markOrderMatched(orderId, "swap-funded", "10", "60");
    const event: P2pSwapEvent = {
      swapId: "swap-unfunded", seq: 0, status, eventType: "cancel", orderId, at: clock,
    };
    await store.appendEvent(event);
    await store.appendEvent(event);
    expect((await store.getOrder(orderId))?.remainingGive).toBe("50");
    const funded = { ...event, swapId: "swap-funded", escrowTxHash: TXID };
    await store.appendEvent(funded);
    expect((await store.getOrder(orderId))?.remainingGive).toBe("50");
    await store.appendEvent({ ...funded, seq: 1, status: "ESCROW_REFUNDED", refundTxHash: TXID });
    expect((await store.getOrder(orderId))?.remainingGive).toBe("100");
    await a.close();
  });

  it.each(["20", "60"])("restores only the failed %s fill after an earlier partial fill", async (fillAmount) => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    const match = (amount: string) => a.inject({
      method: "POST", url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid, fillAmount: amount, receiveAddress: RECEIVE_ADDRESS,
        requestMethod: "POST", requestPath: `/orders/${orderId}/match`,
      }),
    });
    expect((await match("40")).statusCode).toBe(201);
    anchorThrows = true;
    expect((await match(fillAmount)).statusCode).toBe(500);
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE", remainingGive: "60" });
    await a.close();
  });

  it("rejects a competing partial fill based on a stale remainder", async () => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    const results = await Promise.all([
      store.markOrderMatched(orderId, "swap-0000000000000001", "40", "100"),
      store.markOrderMatched(orderId, "swap-0000000000000002", "40", "100"),
    ]);
    expect(results).toEqual([true, false]);
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE", remainingGive: "40" });
    await a.close();
  });

  it("rejects stale events before anchoring and does not discard them silently", async () => {
    const event: P2pSwapEvent = {
      swapId: "swap-0000000000000001", seq: 0, status: "PAYMENT_PENDING",
      eventType: "instructions", sellerDid, buyerDid, at: clock,
    };
    await store.appendEvent(event);
    let anchored = 0;
    const proof = { ...event, seq: 1, status: "PAYMENT_CLAIMED" as const, eventType: "payment_proof" as const };
    const confirm = { ...event, seq: 1, status: "PAYMENT_VERIFIED" as const, eventType: "payment_confirm" as const };
    const results = await Promise.allSettled([
      store.appendEvent(proof, async () => { anchored++; return proof; }),
      store.appendEvent(confirm, async () => { anchored++; return confirm; }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(anchored).toBe(1);
    await expect(store.appendEvent(confirm)).rejects.toMatchObject({ statusCode: 409 });
    await store.appendEvent({ ...confirm, seq: 2 }, async () => ({ ...confirm, seq: 2 }));
    expect((await store.getSwap(event.swapId))?.status).toBe("PAYMENT_VERIFIED");
  });

  it("preserves partial-fill remainders in the blob projection", async () => {
    const a = await app();
    const created = await a.inject({ method: "POST", url: "/orders", payload: orderPayload() });
    const orderId = created.json().orderId;
    const projection = new BlobSettlementStore(new MemBlobStore(), store);
    expect(await projection.markOrderMatched(orderId, "swap-0000000000000001", "40")).toBe(true);
    expect(await projection.getOrder(orderId)).toMatchObject({ status: "ACTIVE", remainingGive: "40" });
    await a.close();
  });

  it("409s a match against a cancelled order", async () => {
    const a = await app();
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId }) });
    clock += 1;
    await a.inject({ method: "POST", url: `/orders/${orderId}/cancel`, payload: signed(seller, sellerDid, { sellerDid, requestMethod: "POST", requestPath: `/orders/${orderId}/cancel` }) });
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(409);
  });

  it("reopens the order when the MATCHED event fails to anchor", async () => {
    const a = await app();
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId }) });
    clock += 1;
    anchorThrows = true;
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(500);
    expect((await store.getOrder(orderId))?.status).toBe("ACTIVE");
  });
});

describe("anchored-record cross-check (verifyOrderTx)", () => {
  function gateApp(verifyOrderTx: NonNullable<Parameters<typeof buildApp>[0]["verifyOrderTx"]>) {
    return buildApp({
      store,
      env: {
        SETTLEMENT_ENGINE_DID: engineDid,
        SETTLEMENT_ADMIN_TOKEN: "adm",
      } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      chain: null,
      now: () => clock,
      orderTxTries: 1,
      verifyOrderTx,
    });
  }

  it("proves the confirmed block carries the posted terms before indexing", async () => {
    const a = await gateApp(async (check) =>
      check.status === "OPEN" && check.terms?.giveAmount === "100"
        ? { ok: false, error: "anchored record giveAmount mismatch" }
        : { ok: true },
    );
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/giveAmount mismatch/);
    expect(await store.getOrder(orderId)).toBeNull();
    const caps = (await a.inject({ method: "GET", url: "/capabilities" })).json();
    expect(caps.chain.orderTxVerify).toBe(true);
  });

  it("accepts when the anchored record matches", async () => {
    const a = await gateApp(async () => ({ ok: true }));
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId, txid: TXID }) });
    expect(r.statusCode).toBe(201);
    expect((await store.getOrder(orderId))?.txid).toBe(TXID);
  });
});

describe("capabilities", () => {
  it("reports orderTxVerify and the watch state", async () => {
    const a = await app();
    const r = await a.inject({ method: "GET", url: "/capabilities" });
    const caps = r.json();
    expect(caps.chain).toMatchObject({ l0: false, l1: true, orderTxVerify: true });
    expect(caps.watch).toEqual({ height: null, hash: null, lastRunAt: null, lastError: null });
  });
});

describe("pinned-order match (enginePubkey, docs/p2p.md §26)", () => {
  const pinnedEnv = {
    SETTLEMENT_ENGINE_KEY: enginePq.getPrivateKeySeedAsHex()!,
    SETTLEMENT_ENGINE_PUBKEY: enginePqPub,
  };

  async function createPinned(enginePubkey: string): Promise<string> {
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    const r = await app(pinnedEnv);
    const created = await r.inject({
      method: "POST",
      url: "/orders",
      payload: orderPayload({ orderId, enginePubkey }),
    });
    expect(created.statusCode).toBe(201);
    return orderId;
  }

  it("matches an order pinned to the key we hold and pins the swap", async () => {
    const a = await app(pinnedEnv);
    const orderId = await createPinned(enginePqPub);
    clock += 1;
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    const swap = (await store.getSwap(m.json().swapId as string))!;
    expect(swap.enginePubkey).toBe(enginePqPub);
  });

  it("409s a match for an order pinned to an engine the deployment does not hold", async () => {
    const a = await app(pinnedEnv);
    const orderId = await createPinned(rogueEnginePub);
    clock += 1;
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(409);
    expect(m.json().error).toMatch(/pinned to an engine/);
  });
});
