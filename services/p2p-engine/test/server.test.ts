import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";

const seller = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);

let clock = 1_700_000_000_000;
const store = new MemSettlementStore();
const anchored: P2pSwapEvent[] = [];
const paypalCalls = {
  invoices: [] as Array<{ swapId: string; buyerEmail: string; amount: string; currency: string }>,
  sends: [] as string[],
  payouts: [] as Array<{ swapId: string; receiver: string; amount: string; currency: string }>,
};
let invoiceFail = false;
let payoutLive: { status?: string; itemId?: string } = { status: "SUCCESS", itemId: "PI-1" };
const paypal = {
  createInvoice: async (swapId: string, buyerEmail: string, amount: string, currency: string) => {
    if (invoiceFail) throw new Error("paypal down");
    paypalCalls.invoices.push({ swapId, buyerEmail, amount, currency });
    return { id: "INV-1", url: "https://paypal.test/i/INV-1" };
  },
  sendInvoice: async (invoiceId: string) => {
    paypalCalls.sends.push(invoiceId);
  },
  createPayout: async (swapId: string, receiver: string, amount: string, currency: string) => {
    paypalCalls.payouts.push({ swapId, receiver, amount, currency });
    return { id: "PO-1", itemId: "PI-1" };
  },
  getPayout: async (_payoutRef: string) => payoutLive,
};

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
    paypal,
    chain: null,
    now: () => clock,
    verifyWebhook: async () => true,
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

/** Runs order → match → lock → payment → verify → release; returns the swap id. */
async function toEscrowReleased(a: TestApp): Promise<string> {
  const r1 = await a.inject({
    method: "POST",
    url: "/orders",
    payload: signed(seller, sellerDid, {
      type: "limit_sell",
      sellerDid,
      giveToken: "USDT",
      giveAmount: "100",
      giveChain: "L0",
      wantCurrency: "USD",
      wantAmount: "101",
      wantRail: "paypal",
      validUntil: Math.floor(clock / 1000) + 3600,
    }),
  });
  const orderId = r1.json().orderId as string;
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${orderId}/match`,
    payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
  });
  const swapId = r2.json().swapId as string;
  bump();
  await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
  });
  bump();
  await a.inject({ method: "POST", url: "/payments/send", payload: signed(buyer, buyerDid, { swapId, paymentRef: "PAY-1" }) });
  bump();
  await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(engine, engineDid, { action: "verify" }),
  });
  bump();
  await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
  });
  bump();
  return swapId;
}

describe("settlement server", () => {
  beforeEach(() => {
    clock = 1_700_000_000_000;
    store.orders.clear();
    store.swapEvents.clear();
    anchored.length = 0;
    paypalCalls.invoices.length = 0;
    paypalCalls.sends.length = 0;
    paypalCalls.payouts.length = 0;
    invoiceFail = false;
    payoutLive = { status: "SUCCESS", itemId: "PI-1" };
  });

  it("runs a full lifecycle through signed requests", async () => {
    const a = await app();

    const orderBody = {
      type: "limit_sell",
      sellerDid,
      giveToken: "USDT",
      giveAmount: "100",
      giveChain: "L0",
      wantCurrency: "USD",
      wantAmount: "101",
      wantRail: "paypal",
      validUntil: Math.floor(clock / 1000) + 3600,
    };
    const r1 = await a.inject({ method: "POST", url: "/orders", payload: signed(seller, sellerDid, orderBody) });
    expect(r1.statusCode).toBe(201);
    const orderId = r1.json().orderId as string;

    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
    });
    expect(r2.statusCode).toBe(201);
    const swapId = r2.json().swapId as string;

    bump();
    const r3 = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().status).toBe("ESCROW_LOCKED");

    bump();
    const r4 = await a.inject({
      method: "POST",
      url: "/payments/send",
      payload: signed(buyer, buyerDid, { swapId, paymentRef: "PAY-1" }),
    });
    expect(r4.json().status).toBe("PAYMENT_PENDING");

    bump();
    const r5 = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "verify" }),
    });
    expect(r5.json().status).toBe("PAYMENT_VERIFIED");

    bump();
    const r6 = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
    });
    expect(r6.json().status).toBe("ESCROW_RELEASED");

    bump();
    const r7 = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    expect(r7.json().status).toBe("COMPLETED");
    expect(r7.json().txid).toBe("a".repeat(64));

    // the audit anchor was called once per event
    expect(anchored.map((e) => e.status)).toEqual([
      "MATCHED",
      "ESCROW_LOCKED",
      "PAYMENT_PENDING",
      "PAYMENT_VERIFIED",
      "ESCROW_RELEASED",
      "COMPLETED",
    ]);

    const view = await a.inject({ method: "GET", url: `/swaps/${swapId}`, headers: { "x-settlement-admin-token": "adm" } });
    expect(view.statusCode).toBe(200);
    expect(view.json().swap.status).toBe("COMPLETED");
    // PII is redacted from the serving view
    expect(view.json().swap.paypalAccount).toBeUndefined();
    expect(view.json().swap.receiveAddress).toBeUndefined();
  });

  it("rejects a buyer self-verifying (engine signer required)", async () => {
    const a = await app();
    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "1",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "1",
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    const orderId = r1.json().orderId;
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1R", paypalAccount: "b@x.com" }),
    });
    const swapId = r2.json().swapId;
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
    });
    bump();
    await a.inject({ method: "POST", url: "/payments/send", payload: signed(buyer, buyerDid, { swapId, paymentRef: "P" }) });
    bump();
    const forged = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(buyer, buyerDid, { action: "verify" }),
    });
    expect(forged.statusCode).toBe(403);
  });

  it("gates order listing behind the admin token", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/orders" })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/orders", headers: { "x-settlement-admin-token": "adm" } })).statusCode).toBe(200);
  });

  it("lists the latest state per swap behind the admin token, redacting PII", async () => {
    const a = await app();
    const base = {
      sellerDid,
      buyerDid,
      giveChain: "L0",
      giveToken: "USDT",
      giveAmount: "100",
      wantAmount: "101",
      wantRail: "paypal",
      wantCurrency: "USD",
      escrowAddress: "ESC",
      receiveAddress: "1Recv",
      paypalAccount: "s@x.com",
    };
    await store.appendEvent({ ...base, swapId: "swap-aaaaaaaaaaaaaaaa", seq: 0, status: "MATCHED", eventType: "match", at: clock });
    await store.appendEvent({ ...base, swapId: "swap-aaaaaaaaaaaaaaaa", seq: 1, status: "ESCROW_LOCKED", eventType: "escrow_lock", at: clock + 1 });
    await store.appendEvent({ ...base, swapId: "swap-bbbbbbbbbbbbbbbb", seq: 0, status: "MATCHED", eventType: "match", at: clock + 2 });

    expect((await a.inject({ method: "GET", url: "/swaps" })).statusCode).toBe(403);
    const res = await a.inject({ method: "GET", url: "/swaps", headers: { "x-settlement-admin-token": "adm" } });
    expect(res.statusCode).toBe(200);
    const swaps = res.json().swaps as any[];
    expect(swaps.map((s) => [s.swapId, s.status])).toEqual([
      ["swap-bbbbbbbbbbbbbbbb", "MATCHED"],
      ["swap-aaaaaaaaaaaaaaaa", "ESCROW_LOCKED"],
    ]);
    expect(swaps[0].paypalAccount).toBeUndefined();
    expect(swaps[0].receiveAddress).toBeUndefined();
    expect((await a.inject({ method: "GET", url: "/swaps?limit=0", headers: { "x-settlement-admin-token": "adm" } })).statusCode).toBe(400);
  });

  it("serves open orders publicly without the admin token or signatures", async () => {
    const a = await app();
    await store.createOrder({
      orderId: `ord-${randomBytes(8).toString("hex")}`,
      type: "limit_sell",
      sellerDid,
      giveToken: "USDT",
      giveAmount: "5",
      giveChain: "L0",
      wantCurrency: "USD",
      wantAmount: "5",
      wantRail: "paypal",
      validUntil: Math.floor(clock / 1000) + 3600,
      status: "ACTIVE",
      signature: "deadbeef",
      createdAt: clock,
    });
    const res = await a.inject({ method: "GET", url: "/public/orders" });
    expect(res.statusCode).toBe(200);
    const orders = res.json().orders as any[];
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0].signature).toBeUndefined();
    expect(orders[0].status).toBe("ACTIVE");
  });

  it("scopes swap reads to the signing party and rejects non-parties", async () => {
    const a = await app();
    const outsider = Ed25519Key.createNewKey();
    const outsiderDid = didFromEd25519Key(outsider);
    const base = {
      sellerDid,
      buyerDid,
      giveChain: "L0",
      giveToken: "USDT",
      giveAmount: "1",
      wantAmount: "1",
      wantRail: "paypal",
      wantCurrency: "USD",
      receiveAddress: "1Recv",
      paypalAccount: "s@x.com",
    };
    const swapId = "swap-cccccccccccccccc";
    await store.appendEvent({ ...base, swapId, seq: 0, status: "MATCHED", eventType: "match", at: clock });

    const mine = await a.inject({ method: "POST", url: "/swaps/mine", payload: signed(buyer, buyerDid, {}) });
    expect(mine.statusCode).toBe(200);
    const swaps = mine.json().swaps as any[];
    expect(swaps.every((s) => s.buyerDid === buyerDid || s.sellerDid === buyerDid)).toBe(true);
    expect(swaps.find((s) => s.swapId === swapId)).toBeTruthy();
    expect(swaps[0].paypalAccount).toBeUndefined();

    const own = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(buyer, buyerDid, { swapId }) });
    expect(own.statusCode).toBe(200);
    expect(own.json().swap.swapId).toBe(swapId);

    const other = await a.inject({ method: "POST", url: "/swaps/get", payload: signed(outsider, outsiderDid, { swapId }) });
    expect(other.statusCode).toBe(403);
    expect((await a.inject({ method: "POST", url: "/swaps/mine", payload: { did: buyerDid } })).statusCode).toBe(400);
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
        giveAmount: "1",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "1",
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it("advances PAYMENT_PENDING → PAYMENT_VERIFIED from a verified webhook, idempotently", async () => {
    const a = await buildApp({
      store,
      env: { SETTLEMENT_ENGINE_DID: engineDid, SETTLEMENT_PAYPAL_INSECURE: "1" } as NodeJS.ProcessEnv,
      guard: new ReplayGuard(() => clock),
      now: () => clock,
      verifyWebhook: async () => true,
    });
    // seed a swap in PAYMENT_PENDING
    const payload = {
      resource: { invoice_number: "swap-0123456789abcdef" },
      event_type: "INVOICING.INVOICE.PAID",
    };
    await store.appendEvent({
      swapId: "swap-0123456789abcdef",
      seq: 2,
      status: "PAYMENT_PENDING",
      eventType: "payment_send",
      buyerDid,
      sellerDid,
      at: clock,
    });
    const w1 = await a.inject({ method: "POST", url: "/webhooks/paypal", payload });
    expect(w1.statusCode).toBe(200);
    expect((await store.getSwap("swap-0123456789abcdef"))!.status).toBe("PAYMENT_VERIFIED");
    const w2 = await a.inject({ method: "POST", url: "/webhooks/paypal", payload });
    expect(w2.statusCode).toBe(200);
    expect((await store.getSwap("swap-0123456789abcdef"))!.seq).toBe(3);
  });

  it("issues the hosted invoice at escrow_lock when the match carried an email", async () => {
    const a = await app();
    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "101",
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid,
        amount: "100",
        receiveAddress: "1Receive",
        paypalAccount: "b@x.com",
        buyerEmail: "buyer@x",
      }),
    });
    const swapId = r2.json().swapId as string;
    bump();
    const lock = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.json().invoiceId).toBe("INV-1");
    expect(lock.json().invoiceUrl).toBe("https://paypal.test/i/INV-1");
    // exact-amount invoice, invoice_number = swapId (docs/p2p.md step 4)
    expect(paypalCalls.invoices).toEqual([
      { swapId, buyerEmail: "buyer@x", amount: "101", currency: "USD" },
    ]);
    expect(paypalCalls.sends).toEqual(["INV-1"]);

    const swap = (await store.getSwap(swapId))!;
    expect(swap.invoiceId).toBe("INV-1");
    expect(swap.buyerEmail).toBe("buyer@x");
    const view = await a.inject({ method: "GET", url: `/swaps/${swapId}`, headers: { "x-settlement-admin-token": "adm" } });
    expect(view.json().swap.invoiceId).toBe("INV-1");
    expect(view.json().swap.buyerEmail).toBeUndefined();
  });

  it("keeps the lock when invoice issuance fails (best-effort step 4)", async () => {
    invoiceFail = true;
    const a = await app();
    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "101",
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid,
        amount: "100",
        receiveAddress: "1Receive",
        paypalAccount: "b@x.com",
        buyerEmail: "buyer@x",
      }),
    });
    const swapId = r2.json().swapId as string;
    bump();
    const lock = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.json().status).toBe("ESCROW_LOCKED");
    expect(lock.json().invoiceId).toBeUndefined();
    expect((await store.getSwap(swapId))!.invoiceId).toBeUndefined();
  });

  it("retries invoice issuance through the admin route, idempotently", async () => {
    const a = await app();
    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "100",
        giveChain: "L0",
        wantCurrency: "USD",
        wantAmount: "101",
        wantRail: "paypal",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, amount: "100", receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
    });
    const swapId = r2.json().swapId as string;
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
    });
    expect(paypalCalls.invoices).toHaveLength(0);

    const noAuth = await a.inject({ method: "POST", url: `/swaps/${swapId}/invoice`, payload: { buyerEmail: "buyer@x" } });
    expect(noAuth.statusCode).toBe(403);

    bump();
    const issue = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/invoice`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { buyerEmail: "buyer@x" },
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().invoiceId).toBe("INV-1");
    expect(paypalCalls.invoices).toHaveLength(1);

    bump();
    const again = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/invoice`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().existing).toBe(true);
    expect(paypalCalls.invoices).toHaveLength(1);

    // a swap that has not locked yet cannot be invoiced
    await store.appendEvent({
      swapId: "swap-fedcba9876543210",
      seq: 0,
      status: "MATCHED",
      eventType: "match",
      buyerDid,
      sellerDid,
      at: clock,
    });
    const early = await a.inject({
      method: "POST",
      url: "/swaps/swap-fedcba9876543210/invoice",
      headers: { "x-settlement-admin-token": "adm" },
      payload: { buyerEmail: "buyer@x" },
    });
    expect(early.statusCode).toBe(409);
  });

  it("records payout evidence and finalizes from the payout webhook, idempotently", async () => {
    const a = await app();
    const swapId = await toEscrowReleased(a);
    const pay = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().status).toBe("COMPLETED");
    expect(pay.json().payoutRef).toBe("PO-1");
    expect(pay.json().payoutStatus).toBe("PENDING");
    let swap = (await store.getSwap(swapId))!;
    expect(swap.payoutStatus).toBe("PENDING");
    expect(swap.payoutItemId).toBe("PI-1");
    expect(paypalCalls.payouts).toHaveLength(1);

    const payload = {
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { batch_header: { sender_batch_id: swapId }, payout_item_id: "PI-1" },
    };
    const w1 = await a.inject({ method: "POST", url: "/webhooks/paypal", payload });
    expect(w1.statusCode).toBe(200);
    expect(w1.json().payoutStatus).toBe("SUCCESS");
    swap = (await store.getSwap(swapId))!;
    expect(swap.status).toBe("COMPLETED");
    expect(swap.payoutStatus).toBe("SUCCESS");

    const w2 = await a.inject({ method: "POST", url: "/webhooks/paypal", payload });
    expect(w2.json().idempotent).toBe(true);
    expect((await store.getSwap(swapId))!.seq).toBe(swap.seq);
  });

  it("surfaces a FAILED payout and allows the payout retry from COMPLETED", async () => {
    const a = await app();
    const swapId = await toEscrowReleased(a);
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    const failed = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "PAYMENT.PAYOUTS-ITEM.FAILED", resource: { batch_header: { sender_batch_id: swapId } } },
    });
    expect(failed.json().payoutStatus).toBe("FAILED");
    expect((await store.getSwap(swapId))!.payoutStatus).toBe("FAILED");

    bump();
    const retry = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe("COMPLETED");
    expect(paypalCalls.payouts).toHaveLength(2);
    expect((await store.getSwap(swapId))!.payoutStatus).toBe("PENDING");
  });

  it("polls the payout outcome through payout-sync (webhook fallback)", async () => {
    const a = await app();
    const swapId = await toEscrowReleased(a);
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    const noAuth = await a.inject({ method: "POST", url: `/swaps/${swapId}/payout-sync` });
    expect(noAuth.statusCode).toBe(403);

    bump();
    const first = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payout-sync`,
      headers: { "x-settlement-admin-token": "adm" },
    });
    expect(first.json()).toMatchObject({ changed: true, payoutStatus: "SUCCESS" });
    const second = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payout-sync`,
      headers: { "x-settlement-admin-token": "adm" },
    });
    expect(second.json()).toMatchObject({ changed: false, payoutStatus: "SUCCESS" });
    expect((await store.getSwap(swapId))!.payoutStatus).toBe("SUCCESS");
  });

  it("freezes verify/release on a reversed capture, but refund stays reachable", async () => {
    const a = await app();
    await store.appendEvent({
      swapId: "swap-1111111111111111",
      seq: 0,
      status: "PAYMENT_PENDING",
      eventType: "payment_send",
      invoiceId: "INV-1",
      buyerDid,
      sellerDid,
      at: clock,
    });
    await store.appendEvent({
      swapId: "swap-2222222222222222",
      seq: 0,
      status: "PAYMENT_VERIFIED",
      eventType: "verify",
      invoiceId: "INV-2",
      buyerDid,
      sellerDid,
      receiveAddress: "1Receive",
      at: clock,
    });

    const rev1 = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "PAYMENT.CAPTURE.REVERSED", resource: { invoice_id: "INV-1" } },
    });
    expect(rev1.json().paymentReversed).toBe(true);
    const verify = await a.inject({
      method: "POST",
      url: "/swaps/swap-1111111111111111/transitions",
      payload: signed(engine, engineDid, { action: "verify" }),
    });
    expect(verify.statusCode).toBe(422);
    expect(verify.json().error).toContain("payment reversed");

    const rev2 = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "PAYMENT.CAPTURE.REVERSED", resource: { invoice_id: "INV-2" } },
    });
    expect(rev2.json().paymentReversed).toBe(true);
    const release = await a.inject({
      method: "POST",
      url: "/swaps/swap-2222222222222222/transitions",
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
    });
    expect(release.statusCode).toBe(422);

    // the seller can still bring locked tokens home: expire → refund
    bump();
    const expire = await a.inject({
      method: "POST",
      url: "/swaps/swap-1111111111111111/transitions",
      payload: signed(seller, sellerDid, { action: "expire" }),
    });
    expect(expire.statusCode).toBe(200);
    bump();
    const refund = await a.inject({
      method: "POST",
      url: "/swaps/swap-1111111111111111/transitions",
      payload: signed(seller, sellerDid, { action: "refund", txHash: "c".repeat(64) }),
    });
    expect(refund.statusCode).toBe(200);
    expect((await store.getSwap("swap-1111111111111111"))!.status).toBe("ESCROW_REFUNDED");
  });

  it("pauses a swap on a dispute until it resolves", async () => {
    const a = await app();
    await store.appendEvent({
      swapId: "swap-3333333333333333",
      seq: 0,
      status: "PAYMENT_PENDING",
      eventType: "payment_send",
      invoiceId: "INV-3",
      buyerDid,
      sellerDid,
      at: clock,
    });
    const opened = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "CUSTOMER.DISPUTE.CREATED", resource: { invoice_id: "INV-3" } },
    });
    expect(opened.json().dispute).toBe("OPEN");
    const dup = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "CUSTOMER.DISPUTE.CREATED", resource: { invoice_id: "INV-3" } },
    });
    expect(dup.json().idempotent).toBe(true);

    const blocked = await a.inject({
      method: "POST",
      url: "/swaps/swap-3333333333333333/transitions",
      payload: signed(engine, engineDid, { action: "verify" }),
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toContain("dispute OPEN");

    const resolved = await a.inject({
      method: "POST",
      url: "/webhooks/paypal",
      payload: { event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { invoice_id: "INV-3" } },
    });
    expect(resolved.json().dispute).toBe("RESOLVED");
    const verify = await a.inject({
      method: "POST",
      url: "/swaps/swap-3333333333333333/transitions",
      payload: signed(engine, engineDid, { action: "verify" }),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().status).toBe("PAYMENT_VERIFIED");
  });
});
