import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
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
    paypal: {
      createInvoice: async () => ({ id: "INV-1", url: "https://paypal.test/i/INV-1" }),
      sendInvoice: async () => {},
      createPayout: async () => ({ id: "PO-1", itemId: "PI-1" }),
      getPayout: async () => ({ status: "SUCCESS", itemId: "PI-1" }),
    },
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

async function saveProfile(a: TestApp, method = "wechat") {
  const r = await a.inject({
    method: "POST",
    url: "/profiles",
    payload: signed(seller, sellerDid, {
      method,
      accountName: "Zhang San",
      account: "wxid_pay888",
      ...(method === "bank" ? { bankName: "ICBC 1234" } : {}),
    }),
  });
  expect(r.statusCode).toBe(200);
}

/** Creates a CNY order (wantRail), matches it with the buyer (no PayPal PII), locks escrow. */
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
  expect(lock.json().status).toBe("ESCROW_LOCKED");
  bump();
  return swapId;
}

describe("CNY rails (docs/p2pcny.md)", () => {
  beforeEach(async () => {
    clock = 1_700_000_000_000;
    store.orders.clear();
    store.swapEvents.clear();
    store.paymentProfiles.clear();
    store.paymentProofs.clear();
    anchored.length = 0;
    await saveProfile(await app());
  });

  it("runs the full CNY flow: instructions → proof → confirm → release → complete", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);

    // buyer pulls instructions: seller profile + per-swap remark, no PayPal involved
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(ins.statusCode).toBe(201);
    expect(ins.json()).toMatchObject({
      swapId,
      status: "PAYMENT_PENDING",
      method: "wechat",
      rail: "wechat",
      accountName: "Zhang San",
      account: "wxid_pay888",
      amount: "715",
      currency: "CNY",
    });
    expect(ins.json().remark).toMatch(/^[0-9a-f]{12}$/);
    expect(ins.json().payBy).toBeGreaterThan(Math.floor(clock / 1000));

    // idempotent re-pull keeps the same remark while PAYMENT_PENDING
    bump();
    const again = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().remark).toBe(ins.json().remark);

    // the seller can read the remark from the swap itself (statement check)
    const view = await a.inject({
      method: "POST",
      url: "/swaps/get",
      payload: signed(seller, sellerDid, { swapId }),
    });
    expect(view.json().swap.remark).toBe(ins.json().remark);
    expect(view.json().swap.paypalAccount).toBeUndefined();

    // a receipt that is not base64 is rejected before anything is stored
    bump();
    const badReceipt = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "4200001234567890", receipt: "data:image/png;base64,@@not-base64@@" }),
    });
    expect(badReceipt.statusCode).toBe(400);
    expect(badReceipt.json().error).toMatch(/base64/);

    // buyer claims the transfer with a receipt image → PAYMENT_CLAIMED
    bump();
    const receipt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const proof = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "4200001234567890", remark: ins.json().remark, receipt }),
    });
    expect(proof.statusCode).toBe(200);
    expect(proof.json()).toMatchObject({ status: "PAYMENT_CLAIMED", txId: "4200001234567890" });
    // the hash covers the image bytes, not the data-URL string — `sha256 <file>`
    // reproduces it (docs/p2pcny.md §8)
    const bytes = Buffer.from(receipt.slice(receipt.indexOf(",") + 1), "base64");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(proof.json().receiptSha256).toBe(sha);
    expect(sha).not.toBe(createHash("sha256").update(receipt, "utf8").digest("hex"));

    // receipt bytes live only in the proof store; the swap event carries the hash
    const proofs = await store.proofs(swapId);
    expect(proofs).toHaveLength(1);
    expect(proofs[0].receipt).toBe(receipt);
    const swapAfter = (await store.getSwap(swapId))!;
    expect(swapAfter.status).toBe("PAYMENT_CLAIMED");
    expect(swapAfter.receiptSha256).toBe(sha);
    expect((swapAfter as Record<string, unknown>).receipt).toBeUndefined();
    expect(swapAfter.paymentRef).toBe("4200001234567890");

    // seller confirms on their own 流水 → PAYMENT_VERIFIED
    bump();
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("PAYMENT_VERIFIED");

    // engine releases tokens and completes — no PayPal payout step exists here
    bump();
    const release = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
    });
    expect(release.json().status).toBe("ESCROW_RELEASED");
    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "complete" }),
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("COMPLETED");

    // anchored sequence covers every step; the anchored record has the hash,
    // never the receipt bytes (docs/p2pcny.md §8)
    expect(anchored.map((e) => e.status)).toEqual([
      "MATCHED",
      "ESCROW_LOCKED",
      "PAYMENT_PENDING",
      "PAYMENT_CLAIMED",
      "PAYMENT_VERIFIED",
      "ESCROW_RELEASED",
      "COMPLETED",
    ]);
    const claimAnchor = anchored.find((e) => e.eventType === "payment_proof")!;
    expect(claimAnchor.receiptSha256).toBe(sha);
    // receipt bytes never reach the anchor; the non-secret remark code does
    // (arbiter evidence check, docs/p2pcny.md §6/§8)
    expect((claimAnchor as Record<string, unknown>).receipt).toBeUndefined();
    expect(claimAnchor.remark).toBe(ins.json().remark);
  });

  it("matches a CNY order without PayPal PII and blocks the PayPal payment hint", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a, "alipay");
    const swap = (await store.getSwap(swapId))!;
    expect(swap.wantRail).toBe("alipay");
    expect(swap.paypalAccount).toBeUndefined();

    const hint = await a.inject({
      method: "POST",
      url: "/payments/send",
      payload: signed(buyer, buyerDid, { swapId, paymentRef: "PAY-1" }),
    });
    expect(hint.statusCode).toBe(409);
    expect(hint.json().error).toContain("proof");

    const payout = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    expect(payout.statusCode).toBe(400);
    expect(payout.json().error).toContain("complete");
  });

  it("validates instructions: rail, status, signer, and profile presence", async () => {
    const a = await app();

    // unknown rail on order creation
    const badOrder = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "1",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "7",
        wantRail: "cash",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    expect(badOrder.statusCode).toBe(400);
    expect(badOrder.json().error).toContain("wantRail not enabled");

    // a restricted engine only exposes its configured CNY rails
    const restricted = await app({ SETTLEMENT_CNY_RAILS: "alipay" });
    const disabled = await restricted.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "1",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "7",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    expect(disabled.statusCode).toBe(400);

    // no profile for this rail yet → 409
    const swapId = await toEscrowLocked(a, "bank");
    const noProfile = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(noProfile.statusCode).toBe(409);
    expect(noProfile.json().error).toContain("no payment profile");

    // now the seller saves one and instructions work
    await saveProfile(a, "bank");
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(ins.statusCode).toBe(201);
    expect(ins.json().method).toBe("bank");
    expect(ins.json().bankName).toBe("ICBC 1234");

    // only the buyer may pull them
    bump();
    const bySeller = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(bySeller.statusCode).toBe(403);

    // instructions before escrow_lock → 409
    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(seller, sellerDid, {
        type: "limit_sell",
        sellerDid,
        giveToken: "USDT",
        giveAmount: "1",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "7",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1R" }),
    });
    bump();
    const early = await a.inject({
      method: "POST",
      url: `/swaps/${r2.json().swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(early.statusCode).toBe(409);

    // PayPal swaps reject the route outright (they have their own flow)
    const r3 = await a.inject({
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
    bump();
    const r4 = await a.inject({
      method: "POST",
      url: `/orders/${r3.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1R", paypalAccount: "b@x.com" }),
    });
    bump();
    const notCny = await a.inject({
      method: "POST",
      url: `/swaps/${r4.json().swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(notCny.statusCode).toBe(400);
    expect(notCny.json().error).toContain("not a CNY swap");
  });

  it("validates proofs: signer, status, txId, and remark match", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);

    // proof before instructions → 409 (status ESCROW_LOCKED)
    const early = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-1" }),
    });
    expect(early.statusCode).toBe(409);

    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(ins.statusCode).toBe(201);
    bump();

    // seller cannot claim for the buyer
    const bySeller = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(seller, sellerDid, { txId: "TX-1" }),
    });
    expect(bySeller.statusCode).toBe(403);

    // invalid txId
    const badTx = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "not valid!" }),
    });
    expect(badTx.statusCode).toBe(400);

    // remark must match the instructions
    const badRemark = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-1", remark: "deadbeefdeadbeef" }),
    });
    expect(badRemark.statusCode).toBe(400);
    expect(badRemark.json().error).toContain("remark");

    // a second claim after PAYMENT_CLAIMED is rejected
    bump();
    const ok = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-1", remark: ins.json().remark }),
    });
    expect(ok.statusCode).toBe(200);
    bump();
    const dup = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-2" }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain("PAYMENT_PENDING");
  });

  it("gates confirm: seller-only, PAYMENT_CLAIMED only, CNY rails only", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);

    // cannot confirm before a claim
    const early = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(early.statusCode).toBe(409);

    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-9" }),
    });

    // the buyer cannot confirm their own payment
    const byBuyer = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(buyer, buyerDid, {}),
    });
    expect(byBuyer.statusCode).toBe(403);

    // PayPal swaps are verified by webhook, never by this route
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
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1R", paypalAccount: "b@x.com" }),
    });
    bump();
    const notCny = await a.inject({
      method: "POST",
      url: `/swaps/${r2.json().swapId}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(notCny.statusCode).toBe(400);

    // and the happy path works
    bump();
    const ok = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("PAYMENT_VERIFIED");
  });

  it("routes the CNY actions through their dedicated endpoints, not transitions", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    for (const action of ["instructions", "payment_proof", "payment_confirm"]) {
      const r = await a.inject({
        method: "POST",
        url: `/swaps/${swapId}/transitions`,
        payload: signed(seller, sellerDid, { action }),
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("dedicated route");
    }
    // and `complete` is engine-only (here signed by the seller)
    bump();
    const forged = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "complete" }),
    });
    expect(forged.statusCode).toBe(403);
  });

  it("freezes a disputed swap and releases tokens when the arbiter sides with the buyer", async () => {
    const a = await app();
    const fresh = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-1" }),
    });

    // outsider cannot dispute
    const outsider = Ed25519Key.createNewKey();
    const outsiderDid = didFromEd25519Key(outsider);
    const denied = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(outsider, outsiderDid, { reason: "not mine" }),
    });
    expect(denied.statusCode).toBe(403);

    bump();
    const opened = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(buyer, buyerDid, { reason: "paid but seller silent" }),
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ dispute: "OPEN", status: "PAYMENT_CLAIMED" });

    // duplicate open → 409
    const dup = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(dup.statusCode).toBe(409);

    // frozen: no instructions, no proof, no confirm
    const confirmBlocked = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(confirmBlocked.statusCode).toBe(422);
    expect(confirmBlocked.json().error).toContain("dispute OPEN");

    // resolve without the admin token → 403
    const noAuth = await a.inject({ method: "POST", url: `/swaps/${fresh}/dispute/resolve`, payload: { outcome: "release" } });
    expect(noAuth.statusCode).toBe(403);

    // arbiter sides with the buyer → status becomes PAYMENT_VERIFIED and the freeze lifts
    bump();
    const resolved = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "release" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ dispute: "RESOLVED", disputeOutcome: "release", status: "PAYMENT_VERIFIED" });

    bump();
    const release = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/transitions`,
      payload: signed(engine, engineDid, { action: "release", txHash: "b".repeat(64) }),
    });
    expect(release.statusCode).toBe(200);
    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/transitions`,
      payload: signed(engine, engineDid, { action: "complete" }),
    });
    expect(complete.statusCode).toBe(200);

    // resolving again → 409 (no active dispute)
    const again = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "release" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("keeps a refund arbitration frozen: confirm blocked, expire → refund reachable", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {}),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, { txId: "TX-1" }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(seller, sellerDid, { reason: "buyer never paid" }),
    });
    bump();
    const badOutcome = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "split" },
    });
    expect(badOutcome.statusCode).toBe(400);

    bump();
    const resolved = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "refund" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ dispute: "RESOLVED", disputeOutcome: "refund", status: "PAYMENT_CLAIMED" });

    // the forward path stays frozen for good
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {}),
    });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.json().error).toContain("refund ordered");

    // but the tokens can come home: expire → refund (seller-signed)
    bump();
    const expire = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "expire" }),
    });
    expect(expire.statusCode).toBe(200);
    bump();
    const refund = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, { action: "refund", txHash: "c".repeat(64) }),
    });
    expect(refund.statusCode).toBe(200);
    expect((await store.getSwap(swapId))!.status).toBe("ESCROW_REFUNDED");
  });

  it("stores seller profiles per method and rejects bad input", async () => {
    const a = await app();

    const mine = await a.inject({ method: "POST", url: "/profiles/mine", payload: signed(seller, sellerDid, {}) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().profiles).toHaveLength(1);
    expect(mine.json().profiles[0]).toMatchObject({ method: "wechat", account: "wxid_pay888" });

    // unsigned / wrong method / oversized account
    expect((await a.inject({ method: "POST", url: "/profiles", payload: { did: sellerDid } })).statusCode).toBe(400);
    const badMethod = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, { method: "paypal", accountName: "x", account: "y" }),
    });
    expect(badMethod.statusCode).toBe(400);
    const badAccount = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, { method: "alipay", accountName: "x", account: "a".repeat(129) }),
    });
    expect(badAccount.statusCode).toBe(400);

    // another seller's profiles are invisible without their key
    const stranger = Ed25519Key.createNewKey();
    const strangerDid = didFromEd25519Key(stranger);
    const strangerMine = await a.inject({ method: "POST", url: "/profiles/mine", payload: signed(stranger, strangerDid, {}) });
    expect(strangerMine.json().profiles).toEqual([]);

    // upsert switches the seller's wechat profile in place
    bump();
    const updated = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, { method: "wechat", accountName: "Li Si", account: "wxid_new999" }),
    });
    expect(updated.statusCode).toBe(200);
    const after = await a.inject({ method: "POST", url: "/profiles/mine", payload: signed(seller, sellerDid, {}) });
    expect(after.json().profiles).toHaveLength(1);
    expect(after.json().profiles[0]).toMatchObject({ accountName: "Li Si", account: "wxid_new999" });

    // profile PII never leaks through admin swap views
    const list = await a.inject({ method: "GET", url: "/swaps", headers: { "x-settlement-admin-token": "adm" } });
    expect(list.json().swaps).toEqual([]);
  });

  it("completes a PayPal swap only through payout, never through complete", async () => {
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
      payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1Receive", paypalAccount: "b@x.com" }),
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
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "complete" }),
    });
    expect(complete.statusCode).toBe(400);
    expect(complete.json().error).toContain("CNY swaps");

    bump();
    const payout = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, { action: "payout" }),
    });
    expect(payout.statusCode).toBe(200);
    expect(payout.json().status).toBe("COMPLETED");
  });
});
