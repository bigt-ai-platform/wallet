import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";

const seller = Ed25519Key.createNewKey();
const other = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const otherDid = didFromEd25519Key(other);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);

let clock = 1_700_000_000_000;
let store = new MemSettlementStore();
let txidOk = true;
let anchorThrows = false;
const TXID = "c".repeat(64);

function signed(key: Ed25519Key, did: string, fields: Record<string, unknown>) {
  const payload = { ...fields, did, nonce: randomBytes(8).toString("hex"), timestamp: clock };
  return { ...payload, signature: signPayload(payload, key.getPrivHex()!) };
}

async function app() {
  return buildApp({
    store,
    env: {
      SETTLEMENT_ENGINE_DID: engineDid,
      SETTLEMENT_ADMIN_TOKEN: "adm",
      SETTLEMENT_PAYPAL_INSECURE: "1",
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    paypal: null,
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
    wantRail: "paypal",
    validUntil: Math.floor(clock / 1000) + 3600,
    ...overrides,
  });
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
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
        orderId,
      }),
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
      payload: signed(seller, sellerDid, { sellerDid, txid: "d".repeat(64) }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ orderId, status: "CANCELLED", txid: "d".repeat(64) });
    expect((await store.getOrder(orderId))?.status).toBe("CANCELLED");
    const again = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid }),
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
      payload: signed(seller, sellerDid, { sellerDid, txid: TXID }),
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
      payload: signed(seller, sellerDid, { sellerDid }),
    });
    expect(unknown.statusCode).toBe(404);
    const stranger = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(other, otherDid, { sellerDid: otherDid }),
    });
    expect(stranger.statusCode).toBe(403);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
    });
    expect(m.statusCode).toBe(201);
    clock += 1;
    const afterMatch = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/cancel`,
      payload: signed(seller, sellerDid, { sellerDid }),
    });
    expect(afterMatch.statusCode).toBe(409);
  });

  it("400s an invalid orderId in the path", async () => {
    const a = await app();
    const r = await a.inject({ method: "POST", url: "/orders/not-an-id/cancel", payload: signed(seller, sellerDid, { sellerDid }) });
    expect(r.statusCode).toBe(400);
  });
});

describe("match claim + reopen on anchor failure", () => {
  it("409s a match against a cancelled order", async () => {
    const a = await app();
    const orderId = `ord-${randomBytes(8).toString("hex")}`;
    await a.inject({ method: "POST", url: "/orders", payload: orderPayload({ orderId }) });
    clock += 1;
    await a.inject({ method: "POST", url: `/orders/${orderId}/cancel`, payload: signed(seller, sellerDid, { sellerDid }) });
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
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
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
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
        SETTLEMENT_PAYPAL_INSECURE: "1",
      } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      paypal: null,
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
