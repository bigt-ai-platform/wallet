import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp, normalizeAnchorMode, rateLimitFromEnv } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";

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
    payload: signed(seller, sellerDid, { method, accountName: "Zhang San", account: "wxid_pay888" }),
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
      validUntil: Math.floor(clock / 1000) + 3600,
    }),
  });
  expect(r1.statusCode).toBe(201);
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${r1.json().orderId}/match`,
    payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1Receive" }),
  });
  expect(r2.statusCode).toBe(201);
  const swapId = r2.json().swapId as string;
  bump();
  const lock = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
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
    payload: signed(buyer, buyerDid, {}),
  });
  expect(ins.statusCode).toBe(201);
  bump();
  const proof = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/proof`,
    payload: signed(buyer, buyerDid, { txId: "4200001234567890", remark: ins.json().remark }),
  });
  expect(proof.statusCode).toBe(200);
  bump();
  const confirm = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/confirm`,
    payload: signed(seller, sellerDid, {}),
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
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
    });
    expect(release.statusCode).toBe(200);
    expect(release.json().status).toBe("ESCROW_RELEASED");
    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "complete" }),
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
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    expect(o.statusCode).toBe(201);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1Receive" }),
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
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    expect(o.statusCode).toBe(201);
    const m = await a.inject({
      method: "POST",
      url: `/orders/${o.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1Receive" }),
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
      payload: signed(buyer, buyerDid, { action: "release", txHash: "b".repeat(64) }),
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
  });

  it("scopes swap reads to the signing party and rejects non-parties", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const mine = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(seller, sellerDid, { swapId }) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().swap.swapId).toBe(swapId);
    const stranger = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(other, otherDid, { swapId }) });
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
});

describe("rateLimitFromEnv", () => {
  it("defaults to the built-in limit when unset or invalid", () => {
    expect(rateLimitFromEnv({} as NodeJS.ProcessEnv)).toBe(10);
    expect(rateLimitFromEnv({ SETTLEMENT_RATE_LIMIT: "abc" } as NodeJS.ProcessEnv)).toBe(10);
    expect(rateLimitFromEnv({ SETTLEMENT_RATE_LIMIT: "0" } as NodeJS.ProcessEnv)).toBe(10);
  });
  it("reads a positive override", () => {
    expect(rateLimitFromEnv({ SETTLEMENT_RATE_LIMIT: "200" } as NodeJS.ProcessEnv)).toBe(200);
  });
});
