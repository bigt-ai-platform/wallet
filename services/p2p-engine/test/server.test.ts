import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp, normalizeAnchorMode, rateLimitsFromEnv } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";
import { RECEIVE_ADDRESS } from "./address.js";

const seller = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const other = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);
const otherDid = didFromEd25519Key(other);

let clock = 1_700_000_000_000;
const store = new MemSettlementStore();
const anchored: P2pSwapEvent[] = [];

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
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    chain: null,
    now: () => clock,
    anchor: async (e) => {
      anchored.push(e);
      return { txid: "a".repeat(64) };
    },
  });
}

function bump() {
  clock += 1;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function saveProfile(a: TestApp, method = "wechat") {
  const r = await a.inject({
    method: "POST",
    url: "/profiles",
    payload: signed(seller, sellerDid, { method, accountName: "Zhang San", account: "wxid_pay888", requestMethod: "POST", requestPath: "/profiles" }),
  });
  expect(r.statusCode).toBe(200);
}

/** order → match → escrow_lock; returns the swap id (CNY rail). */
async function toEscrowLocked(a: TestApp, wantRail = "wechat"): Promise<string> {
  const r1 = await a.inject({
    method: "POST",
    url: "/orders",
    payload: signed(seller, sellerDid, {
      type: "limit_sell",
      sellerDid,
      giveToken: "USDT",
      giveAmount: "100",
      giveChain: "L0",
      wantCurrency: "CNY",
      wantAmount: "715",
      wantRail,
      validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
  });
  expect(r1.statusCode).toBe(201);
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${r1.json().orderId}/match`,
    payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${r1.json().orderId}/match` }),
  });
  expect(r2.statusCode).toBe(201);
  const swapId = r2.json().swapId as string;
  bump();
  const lock = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64), requestMethod: "POST", requestPath: `/swaps/${swapId}/transitions` }),
  });
  expect(lock.statusCode).toBe(200);
  bump();
  return swapId;
}

/** escrow_locked → instructions → proof → confirm; returns the swap id. */
async function toPaymentVerified(a: TestApp): Promise<string> {
  const swapId = await toEscrowLocked(a);
  const ins = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/payment-instructions`,
    payload: signed(buyer, buyerDid, { requestMethod: "POST", requestPath: `/swaps/${swapId}/payment-instructions` }),
  });
  expect(ins.statusCode).toBe(201);
  bump();
  const proof = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/proof`,
    payload: signed(buyer, buyerDid, { txId: "4200001234567890", remark: ins.json().remark, requestMethod: "POST", requestPath: `/swaps/${swapId}/proof` }),
  });
  expect(proof.statusCode).toBe(200);
  bump();
  const confirm = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/confirm`,
    payload: signed(seller, sellerDid, { requestMethod: "POST", requestPath: `/swaps/${swapId}/confirm` }),
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json().status).toBe("PAYMENT_VERIFIED");
  bump();
  return swapId;
}

describe("settlement server", () => {
  beforeEach(async () => {
    clock = 1_700_000_000_000;
    store.orders.clear();
    store.swapEvents.clear();
    store.paymentProfiles.clear();
    store.paymentProofs.clear();
    anchored.length = 0;
    await saveProfile(await app());
  });

  it("reports only the enabled CNY rails (no paypal)", async () => {
    const a = await app();
    const caps = (await a.inject({ method: "GET", url: "/capabilities" })).json();
    expect(caps.rails).toEqual(["wechat", "alipay", "bank"]);
    expect(caps.paypal).toBeUndefined();
  });

  it("runs a full lifecycle through signed requests", async () => {
    const a = await app();
    const swapId = await toPaymentVerified(a);

    const release = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64), requestMethod: "POST", requestPath: `/swaps/${swapId}/transitions` }),
    });
    expect(release.statusCode).toBe(200);
    expect(release.json().status).toBe("ESCROW_RELEASED");
    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "complete", requestMethod: "POST", requestPath: `/swaps/${swapId}/transitions` }),
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("COMPLETED");

    expect(anchored.map((e) => e.status)).toEqual([
      "MATCHED",
      "ESCROW_LOCKED",
      "PAYMENT_PENDING",
      "PAYMENT_CLAIMED",
      "PAYMENT_VERIFIED",
      "ESCROW_RELEASED",
      "COMPLETED",
    ]);
  });

  it("fails closed when the anchor is required (default)", async () => {
    const a = await buildApp({
      store,
      env: { SETTLEMENT_ENGINE_DID: engineDid, SETTLEMENT_ADMIN_TOKEN: "adm" } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      chain: null,
      now: () => clock,
      anchor: async () => {
        throw new Error("insufficient spendable outputs for social tx");
      },
    });
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${o.json().orderId}/match` }),
    });
    expect(m.statusCode).toBe(500);
  });

  it("stores the swap without a chain record when the anchor is best-effort", async () => {
    const a = await buildApp({
      store,
      env: { SETTLEMENT_ENGINE_DID: engineDid, SETTLEMENT_ADMIN_TOKEN: "adm" } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      chain: null,
      now: () => clock,
      anchor: async () => {
        throw new Error("insufficient spendable outputs for social tx");
      },
      anchorBestEffort: true,
    });
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${o.json().orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    const swapId = m.json().swapId as string;
    // Stored (L0-settleable) but with no L1-SOCIAL chain record.
    const swap = await store.getSwap(swapId);
    expect(swap?.status).toBe("MATCHED");
    expect(swap?.txid).toBeFalsy();
  });

  it("rejects an unsigned order", async () => {
    const a = await app();
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/signature/);
  });

  it("rejects a buyer self-releasing (engine signer required)", async () => {
    const a = await app();
    const swapId = await toPaymentVerified(a);
    const r = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(buyer, buyerDid, { action: "release", txHash: "b".repeat(64), requestMethod: "POST", requestPath: `/swaps/${swapId}/transitions` }),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/engine signer/);
  });

  it("gates order listing behind the admin token", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/orders" })).statusCode).toBe(403);
    const ok = await a.inject({ method: "GET", url: "/orders", headers: { "x-settlement-admin-token": "adm" } });
    expect(ok.statusCode).toBe(200);
  });

  it("lists the latest state per swap behind the admin token, redacting PII", async () => {
    const a = await app();
    await toEscrowLocked(a);
    const r = await a.inject({ method: "GET", url: "/swaps?limit=10", headers: { "x-settlement-admin-token": "adm" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().swaps).toHaveLength(1);
    expect(r.json().swaps[0].receiveAddress).toBeUndefined();
  });

  it("serves open orders publicly without the admin token or signatures", async () => {
    const a = await app();
    await toEscrowLocked(a);
    const r = await a.inject({ method: "GET", url: "/public/orders?status=MATCHED" });
    expect(r.statusCode).toBe(200);
    expect(r.json().orders[0].signature).toBeUndefined();
    for (const status of ["", "PENDING", "active"]) {
      expect((await a.inject({ method: "GET", url: `/public/orders?status=${status}` })).statusCode).toBe(400);
    }
  });

  it("scopes swap reads to the signing party and rejects non-parties", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const mine = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(seller, sellerDid, { swapId, requestMethod: "POST", requestPath: "/swaps/get" }) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().swap.swapId).toBe(swapId);
    const stranger = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(other, otherDid, { swapId, requestMethod: "POST", requestPath: "/swaps/get" }) });
    expect(stranger.statusCode).toBe(403);
  });

  it("has removed every PayPal route", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    for (const url of ["/payments/send", `/swaps/${swapId}/invoice`, `/swaps/${swapId}/payout-sync`, "/webhooks/paypal"]) {
      const gone = await a.inject({ method: "POST", url, payload: signed(engine, engineDid, {}) });
      expect(gone.statusCode, url).toBe(404);
    }
  });
});

describe("normalizeAnchorMode", () => {
  it("defaults to best-effort so L1 never blocks the L0 settlement", () => {
    expect(normalizeAnchorMode(undefined)).toBe("best-effort");
    expect(normalizeAnchorMode("")).toBe("best-effort");
    expect(normalizeAnchorMode("nonsense")).toBe("best-effort");
  });
  it("accepts required and off (case/space-insensitive)", () => {
    expect(normalizeAnchorMode("required")).toBe("required");
    expect(normalizeAnchorMode(" OFF ")).toBe("off");
  });
  it("requires anchoring when blob mode keeps swap events only in memory", () => {
    expect(normalizeAnchorMode(undefined, "blob")).toBe("required");
    expect(normalizeAnchorMode("required", "blob")).toBe("required");
    expect(() => normalizeAnchorMode("best-effort", "blob")).toThrow(/lost on restart/);
    expect(() => normalizeAnchorMode("off", "blob")).toThrow(/lost on restart/);
    expect(normalizeAnchorMode(undefined, "pg")).toBe("best-effort");
  });
});

describe("rateLimitsFromEnv", () => {
  it("defaults to write=10 / read=120 when unset or invalid", () => {
    expect(rateLimitsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ write: 10, read: 120 });
    expect(rateLimitsFromEnv({ SETTLEMENT_RATE_LIMIT: "abc" } as NodeJS.ProcessEnv)).toEqual({ write: 10, read: 120 });
    expect(rateLimitsFromEnv({ SETTLEMENT_RATE_LIMIT: "0" } as NodeJS.ProcessEnv)).toEqual({ write: 10, read: 120 });
  });
  it("reads positive overrides for both classes", () => {
    expect(
      rateLimitsFromEnv({ SETTLEMENT_RATE_LIMIT: "200", SETTLEMENT_RATE_LIMIT_READ: "500" } as NodeJS.ProcessEnv),
    ).toEqual({ write: 200, read: 500 });
  });
});

describe("buy orders (limit_buy)", () => {
  it("maps the taker to the seller and the poster to the buyer", async () => {
    const a = await app();
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(buyer, buyerDid, {
        type: "limit_buy",
        sellerDid: buyerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
        receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    bump();
    // The seller (token giver) takes the bid; it does not send a receive
    // address — the engine uses the poster's.
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(seller, sellerDid, { buyerDid: sellerDid, requestMethod: "POST", requestPath: `/orders/${o.json().orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    const swap = await store.getSwap(m.json().swapId as string);
    expect(swap?.sellerDid).toBe(sellerDid); // taker funds the escrow
    expect(swap?.buyerDid).toBe(buyerDid); // poster pays the fiat
    expect(swap?.receiveAddress).toBe(RECEIVE_ADDRESS);
  });

  it("requires a receive address on a buy order", async () => {
    const a = await app();
    const r = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(buyer, buyerDid, {
        type: "limit_buy",
        sellerDid: buyerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects matching your own order", async () => {
    const a = await app();
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    bump();
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(seller, sellerDid, { buyerDid: sellerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${o.json().orderId}/match` }),
    });
    expect(m.statusCode).toBe(409);
  });

  it("uses the ad's payment window (timeLimit) for the instructions payBy", async () => {
    const a = await app();
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 86400,
        timeLimit: 60, // 60 minutes → 3600s
        requestMethod: "POST", requestPath: "/orders",
      }),
    });
    expect(o.statusCode).toBe(201);
    bump();
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, requestMethod: "POST", requestPath: `/orders/${o.json().orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    bump();
    const swapId = m.json().swapId as string;
    const lock = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64), requestMethod: "POST", requestPath: `/swaps/${swapId}/transitions` }),
    });
    expect(lock.statusCode).toBe(200);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, { requestMethod: "POST", requestPath: `/swaps/${swapId}/payment-instructions` }),
    });
    expect(ins.statusCode).toBe(201);
    expect(ins.json().payBy).toBe(Math.floor(clock / 1000) + 3600);
  });

  it("supports a partial fill within the order limit", async () => {
    const a = await app();
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715", // unit 7.15
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 86400,
        minOrder: "100",
        maxOrder: "800", requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    const orderId = o.json().orderId as string;
    bump();
    const m1 = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, fillAmount: "40", requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m1.statusCode).toBe(201);
    const swap1 = await store.getSwap(m1.json().swapId as string);
    expect(swap1?.giveAmount).toBe("40");
    expect(swap1?.wantAmount).toBe("286"); // 40 × 7.15
    expect((await store.getOrder(orderId))?.status).toBe("ACTIVE");
    expect((await store.getOrder(orderId))?.remainingGive).toBe("60");
    bump();
    // Below the ad's minimum → rejected.
    const m2 = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(other, otherDid, { buyerDid: otherDid, receiveAddress: RECEIVE_ADDRESS, fillAmount: "5", requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m2.statusCode).toBe(409);
    bump();
    // Fill the rest → the order closes.
    const m3 = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, fillAmount: "60", requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m3.statusCode).toBe(201);
    const closed = await store.getOrder(orderId);
    expect(closed?.status).toBe("MATCHED");
    expect(closed?.remainingGive).toBe("0");
  });

  it("matches with a chosen rail from the ad's methods", async () => {
    const a = await app();
    const o = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        wantRails: ["wechat", "alipay"],
        validUntil: Math.floor(clock / 1000) + 3600, requestMethod: "POST", requestPath: "/orders" }),
    });
    expect(o.statusCode).toBe(201);
    const orderId = o.json().orderId as string;
    bump();
    const m = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: RECEIVE_ADDRESS, rail: "alipay", fillAmount: "40", requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(m.statusCode).toBe(201);
    expect((await store.getSwap(m.json().swapId as string))?.wantRail).toBe("alipay");
    bump();
    // A rail the ad does not offer is rejected.
    const bad = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(other, otherDid, { buyerDid: otherDid, receiveAddress: RECEIVE_ADDRESS, rail: "bank", fillAmount: "10", requestMethod: "POST", requestPath: `/orders/${orderId}/match` }),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("per-IP rate limit", () => {
  async function limitedApp() {
    return buildApp({
      store,
      env: { SETTLEMENT_ENGINE_DID: engineDid, SETTLEMENT_ADMIN_TOKEN: "adm", SETTLEMENT_IP_RATE_LIMIT: "3" } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      chain: null,
      now: () => clock,
      log: false,
    });
  }

  it("caps one IP and leaves other IPs alone", async () => {
    const a = await limitedApp();
    const hit = (remoteAddress: string) => a.inject({ method: "GET", url: "/capabilities", remoteAddress });
    expect((await hit("10.0.0.1")).statusCode).toBe(200);
    expect((await hit("10.0.0.1")).statusCode).toBe(200);
    expect((await hit("10.0.0.1")).statusCode).toBe(200);
    expect((await hit("10.0.0.1")).statusCode).toBe(429);
    // A different client is unaffected, and /healthz is never limited.
    expect((await hit("10.0.0.2")).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/healthz", remoteAddress: "10.0.0.1" })).statusCode).toBe(200);
  });
});
