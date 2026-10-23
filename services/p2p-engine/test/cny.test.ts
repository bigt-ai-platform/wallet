import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";
import type { P2pSwapEvent } from "../src/types.js";
import { RECEIVE_ADDRESS } from "./address.js";

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
  const payload = {
    ...fields,
    did,
    nonce: randomBytes(8).toString("hex"),
    timestamp: clock,
  };
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
    anchor: async (e) => {
      anchored.push(e);
      return { txid: "a".repeat(64) };
    },
  });
}

function bump() {
  clock += 1;
}

function sweepTick(a: TestApp): Promise<void> {
  return (a as unknown as { sweepTick: () => Promise<void> }).sweepTick();
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
      requestMethod: "POST",
      requestPath: "/profiles",
    }),
  });
  expect(r.statusCode).toBe(200);
}

/** Creates a CNY order (wantRail), matches it with the buyer (no PayPal PII), locks escrow. */
async function toEscrowLocked(
  a: TestApp,
  wantRail = "wechat",
): Promise<string> {
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
      requestMethod: "POST",
      requestPath: "/orders",
    }),
  });
  expect(r1.statusCode).toBe(201);
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${r1.json().orderId}/match`,
    payload: signed(buyer, buyerDid, {
      buyerDid,
      receiveAddress: RECEIVE_ADDRESS,
      requestMethod: "POST",
      requestPath: `/orders/${r1.json().orderId}/match`,
    }),
  });
  expect(r2.statusCode).toBe(201);
  const swapId = r2.json().swapId as string;
  bump();
  const lock = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(seller, sellerDid, {
      action: "escrow_lock",
      txHash: swapId.slice(5).padEnd(64, "f"),
      requestMethod: "POST",
      requestPath: `/swaps/${swapId}/transitions`,
    }),
  });
  expect(lock.statusCode).toBe(200);
  expect(lock.json().status).toBe("ESCROW_LOCKED");
  bump();
  return swapId;
}

describe("CNY rails (docs/p2p.md)", () => {
  it("returns a conflict for simultaneous proof and confirmation instead of false success", async () => {
    const a = await app();
    const swapId = "swap-0000000000000005";
    await store.appendEvent({
      swapId,
      seq: 0,
      status: "PAYMENT_PENDING",
      eventType: "instructions",
      sellerDid,
      buyerDid,
      wantRail: "wechat",
      at: clock,
    });
    const originalGetSwap = store.getSwap.bind(store);
    let readers = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.getSwap = async (id) => {
      const snapshot = await originalGetSwap(id);
      if (id === swapId && readers < 2) {
        readers++;
        if (readers === 2) release();
        await gate;
      }
      return snapshot;
    };
    try {
      const confirmPath = `/swaps/${swapId}/confirm`;
      const proofPath = `/swaps/${swapId}/proof`;
      const results = await Promise.all([
        a.inject({
          method: "POST",
          url: confirmPath,
          payload: signed(seller, sellerDid, {
            requestMethod: "POST",
            requestPath: confirmPath,
          }),
        }),
        a.inject({
          method: "POST",
          url: proofPath,
          payload: signed(buyer, buyerDid, {
            txId: "TX-1",
            requestMethod: "POST",
            requestPath: proofPath,
          }),
        }),
      ]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([
        200, 409,
      ]);
      expect((await store.getSwap(swapId))?.status).toBe(
        results.find((response) => response.statusCode === 200)!.json().status,
      );
      expect(
        anchored.filter((event) => event.swapId === swapId && event.seq === 1),
      ).toHaveLength(1);
    } finally {
      store.getSwap = originalGetSwap;
      await a.close();
    }
  });

  it("rejects redirected reads and keeps a fixed payment deadline for expiry", async () => {
    const a = await app({ SETTLEMENT_CNY_REMARK_TTL: "900" });
    const swapId = await toEscrowLocked(a);
    const instructionsPath = `/swaps/${swapId}/payment-instructions`;
    const instructions = await a.inject({
      method: "POST",
      url: instructionsPath,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: instructionsPath,
      }),
    });
    expect(instructions.statusCode).toBe(201);
    const confirmPath = `/swaps/${swapId}/confirm`;
    const redirected = await a.inject({
      method: "POST",
      url: confirmPath,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: "/swaps/mine",
      }),
    });
    expect(redirected.statusCode).toBe(400);
    expect((await store.getSwap(swapId))?.status).toBe("PAYMENT_PENDING");
    const transitionsPath = `/swaps/${swapId}/transitions`;
    const expire = () =>
      a.inject({
        method: "POST",
        url: transitionsPath,
        payload: signed(seller, sellerDid, {
          action: "expire",
          requestMethod: "POST",
          requestPath: transitionsPath,
        }),
      });
    expect((await expire()).statusCode).toBe(409);
    clock += 60_000;
    const repeated = await a.inject({
      method: "POST",
      url: instructionsPath,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: instructionsPath,
      }),
    });
    expect(repeated.json().payBy).toBe(instructions.json().payBy);
    clock = instructions.json().payBy * 1000 - 1;
    await sweepTick(a);
    expect((await store.getSwap(swapId))?.status).toBe("PAYMENT_PENDING");
    expect((await expire()).statusCode).toBe(409);
    clock += 1;
    expect((await expire()).statusCode).toBe(200);
    await a.close();
  });

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
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
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
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().remark).toBe(ins.json().remark);

    // the seller can read the remark from the swap itself (statement check)
    const view = await a.inject({
      method: "POST",
      url: "/swaps/get",
      payload: signed(seller, sellerDid, {
        swapId,
        requestMethod: "POST",
        requestPath: "/swaps/get",
      }),
    });
    expect(view.json().swap.remark).toBe(ins.json().remark);
    expect(view.json().swap.receiveAddress).toBeUndefined();

    // a receipt that is not base64 is rejected before anything is stored
    bump();
    const badReceipt = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "4200001234567890",
        receipt: "data:image/png;base64,@@not-base64@@",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(badReceipt.statusCode).toBe(400);
    expect(badReceipt.json().error).toMatch(/base64/);

    // buyer claims the transfer with a receipt image → PAYMENT_CLAIMED
    bump();
    const receipt = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const proof = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "4200001234567890",
        remark: ins.json().remark,
        receipt,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(proof.statusCode).toBe(200);
    expect(proof.json()).toMatchObject({
      status: "PAYMENT_CLAIMED",
      txId: "4200001234567890",
    });
    // the hash covers the image bytes, not the data-URL string — `sha256 <file>`
    // reproduces it (docs/p2p.md §14)
    const bytes = Buffer.from(
      receipt.slice(receipt.indexOf(",") + 1),
      "base64",
    );
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(proof.json().receiptSha256).toBe(sha);
    expect(sha).not.toBe(
      createHash("sha256").update(receipt, "utf8").digest("hex"),
    );

    // receipt bytes live only in the proof store; the swap event carries the hash
    const proofs = await store.proofs(swapId);
    expect(proofs).toHaveLength(1);
    expect(proofs[0].receipt).toBe(receipt);
    const swapAfter = (await store.getSwap(swapId))!;
    expect(swapAfter.status).toBe("PAYMENT_CLAIMED");
    expect(swapAfter.receiptSha256).toBe(sha);
    expect((swapAfter as Record<string, unknown>).receipt).toBeUndefined();

    // seller confirms on their own 流水 → PAYMENT_VERIFIED
    bump();
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("PAYMENT_VERIFIED");

    // engine releases tokens and completes — no separate fiat payout step exists here
    bump();
    const release = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, {
        action: "release",
        txHash: "b".repeat(64),
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(release.json().status).toBe("ESCROW_RELEASED");
    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, {
        action: "complete",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("COMPLETED");

    // anchored sequence covers every step; the anchored record has the hash,
    // never the receipt bytes (docs/p2p.md §14)
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
    // (arbiter evidence check, docs/p2p.md §12/§14)
    expect((claimAnchor as Record<string, unknown>).receipt).toBeUndefined();
    expect(claimAnchor.remark).toBe(ins.json().remark);
  });

  it("matches a CNY order and rejects the removed PayPal routes", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a, "alipay");
    const swap = (await store.getSwap(swapId))!;
    expect(swap.wantRail).toBe("alipay");

    // the PayPal payment-hint route is gone
    const hint = await a.inject({
      method: "POST",
      url: "/payments/send",
      payload: signed(buyer, buyerDid, {
        swapId,
        paymentRef: "PAY-1",
        requestMethod: "POST",
        requestPath: "/payments/send",
      }),
    });
    expect(hint.statusCode).toBe(404);

    // and the PayPal payout action is no longer a known transition
    const payout = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, {
        action: "payout",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(payout.statusCode).toBe(400);
    expect(payout.json().error).toContain("unknown action");
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
        requestMethod: "POST",
        requestPath: "/orders",
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
        requestMethod: "POST",
        requestPath: "/orders",
      }),
    });
    expect(disabled.statusCode).toBe(400);

    // no profile for this rail yet → 409
    const swapId = await toEscrowLocked(a, "bank");
    const noProfile = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    expect(noProfile.statusCode).toBe(409);
    expect(noProfile.json().error).toContain("no payment profile");

    // now the seller saves one and instructions work
    await saveProfile(a, "bank");
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    expect(ins.statusCode).toBe(201);
    expect(ins.json().method).toBe("bank");
    expect(ins.json().bankName).toBe("ICBC 1234");

    // only the buyer may pull them
    bump();
    const bySeller = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
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
        requestMethod: "POST",
        requestPath: "/orders",
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyer, buyerDid, {
        buyerDid,
        receiveAddress: RECEIVE_ADDRESS,
        requestMethod: "POST",
        requestPath: `/orders/${r1.json().orderId}/match`,
      }),
    });
    bump();
    const early = await a.inject({
      method: "POST",
      url: `/swaps/${r2.json().swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${r2.json().swapId}/payment-instructions`,
      }),
    });
    expect(early.statusCode).toBe(409);
  });

  it("validates proofs: signer, status, txId, and remark match", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);

    // proof before instructions → 409 (status ESCROW_LOCKED)
    const early = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(early.statusCode).toBe(409);

    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    expect(ins.statusCode).toBe(201);
    bump();

    // seller cannot claim for the buyer
    const bySeller = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(seller, sellerDid, {
        txId: "TX-1",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(bySeller.statusCode).toBe(403);

    // invalid txId
    const badTx = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "not valid!",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(badTx.statusCode).toBe(400);

    // remark must match the instructions
    const badRemark = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: "deadbeefdeadbeef",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(badRemark.statusCode).toBe(400);
    expect(badRemark.json().error).toContain("remark");

    // a second claim after PAYMENT_CLAIMED is rejected
    bump();
    const ok = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    expect(ok.statusCode).toBe(200);
    bump();
    const dup = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-2",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
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
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(early.statusCode).toBe(409);

    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-9",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });

    // the buyer cannot confirm their own payment
    const byBuyer = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(byBuyer.statusCode).toBe(403);

    // and the happy path works
    bump();
    const ok = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
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
        payload: signed(seller, sellerDid, {
          action,
          requestMethod: "POST",
          requestPath: `/swaps/${swapId}/transitions`,
        }),
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("dedicated route");
    }
    // and `complete` is engine-only (here signed by the seller)
    bump();
    const forged = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, {
        action: "complete",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
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
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/proof`,
      }),
    });

    // outsider cannot dispute
    const outsider = Ed25519Key.createNewKey();
    const outsiderDid = didFromEd25519Key(outsider);
    const denied = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(outsider, outsiderDid, {
        reason: "not mine",
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/dispute`,
      }),
    });
    expect(denied.statusCode).toBe(403);

    bump();
    const opened = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(buyer, buyerDid, {
        reason: "paid but seller silent",
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/dispute`,
      }),
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      dispute: "OPEN",
      status: "PAYMENT_CLAIMED",
    });

    // duplicate open → 409
    const dup = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/dispute`,
      }),
    });
    expect(dup.statusCode).toBe(409);

    // frozen: no instructions, no proof, no confirm
    const confirmBlocked = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/confirm`,
      }),
    });
    expect(confirmBlocked.statusCode).toBe(422);
    expect(confirmBlocked.json().error).toContain("dispute OPEN");

    // resolve without the admin token → 403
    const noAuth = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute/resolve`,
      payload: { outcome: "release" },
    });
    expect(noAuth.statusCode).toBe(403);

    // arbiter sides with the buyer → the resolve is self-executing (§12): the
    // freeze lifts AND the release settles in the same call (mem store: the
    // plain unproved transition, exactly like every settle without a chain).
    bump();
    const resolved = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "release" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      dispute: "RESOLVED",
      disputeOutcome: "release",
      status: "ESCROW_RELEASED",
      settled: true,
    });

    bump();
    const complete = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/transitions`,
      payload: signed(engine, engineDid, {
        action: "complete",
        requestMethod: "POST",
        requestPath: `/swaps/${fresh}/transitions`,
      }),
    });
    expect(complete.statusCode).toBe(200);
    expect((await store.getSwap(fresh))!.status).toBe("COMPLETED");

    // resolving again → 409 (no active dispute)
    const again = await a.inject({
      method: "POST",
      url: `/swaps/${fresh}/dispute/resolve`,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "release" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("keeps a refund arbitration frozen: confirm blocked, the refund settles in the resolve", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(seller, sellerDid, {
        reason: "buyer never paid",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/dispute`,
      }),
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
    // Self-executing (§12): the engine-act expire + the refund settle in the
    // resolve itself — the seller does not have to come back for the tokens.
    expect(resolved.json()).toMatchObject({
      dispute: "RESOLVED",
      disputeOutcome: "refund",
      status: "ESCROW_REFUNDED",
      settled: true,
    });
    const settled = (await store.getSwap(swapId))!;
    expect(settled.status).toBe("ESCROW_REFUNDED");
    // the unwind is on the log: dispute_resolve → expire → refund
    const tail = (await store.events(swapId)).map((e) => e.eventType).slice(-3);
    expect(tail).toEqual(["dispute_resolve", "expire", "refund"]);

    // the forward path stays frozen for good
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.json().error).toContain("refund ordered");

    // nothing left to drive: expire over a settled escrow is a 409, not a race
    bump();
    const expire = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, {
        action: "expire",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(expire.statusCode).toBe(409);
  });

  it("stores seller profiles per method and rejects bad input", async () => {
    const a = await app();

    const mine = await a.inject({
      method: "POST",
      url: "/profiles/mine",
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: "/profiles/mine",
      }),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().profiles).toHaveLength(1);
    expect(mine.json().profiles[0]).toMatchObject({
      method: "wechat",
      account: "wxid_pay888",
    });

    // unsigned / wrong method / oversized account
    expect(
      (
        await a.inject({
          method: "POST",
          url: "/profiles",
          payload: { did: sellerDid },
        })
      ).statusCode,
    ).toBe(400);
    const badMethod = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, {
        method: "paypal",
        accountName: "x",
        account: "y",
        requestMethod: "POST",
        requestPath: "/profiles",
      }),
    });
    expect(badMethod.statusCode).toBe(400);
    const badAccount = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, {
        method: "alipay",
        accountName: "x",
        account: "a".repeat(129),
        requestMethod: "POST",
        requestPath: "/profiles",
      }),
    });
    expect(badAccount.statusCode).toBe(400);

    // another seller's profiles are invisible without their key
    const stranger = Ed25519Key.createNewKey();
    const strangerDid = didFromEd25519Key(stranger);
    const strangerMine = await a.inject({
      method: "POST",
      url: "/profiles/mine",
      payload: signed(stranger, strangerDid, {
        requestMethod: "POST",
        requestPath: "/profiles/mine",
      }),
    });
    expect(strangerMine.json().profiles).toEqual([]);

    // upsert switches the seller's wechat profile in place
    bump();
    const updated = await a.inject({
      method: "POST",
      url: "/profiles",
      payload: signed(seller, sellerDid, {
        method: "wechat",
        accountName: "Li Si",
        account: "wxid_new999",
        requestMethod: "POST",
        requestPath: "/profiles",
      }),
    });
    expect(updated.statusCode).toBe(200);
    const after = await a.inject({
      method: "POST",
      url: "/profiles/mine",
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: "/profiles/mine",
      }),
    });
    expect(after.json().profiles).toHaveLength(1);
    expect(after.json().profiles[0]).toMatchObject({
      accountName: "Li Si",
      account: "wxid_new999",
    });

    // profile PII never leaks through admin swap views
    const list = await a.inject({
      method: "GET",
      url: "/swaps",
      headers: { "x-settlement-admin-token": "adm" },
    });
    expect(list.json().swaps).toEqual([]);
  });

  it("has no PayPal payout step — complete is the only terminal transition", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    // `payout` was the PayPal-only terminal action; it is no longer known.
    const payout = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(engine, engineDid, {
        action: "payout",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(payout.statusCode).toBe(400);
    expect(payout.json().error).toContain("unknown action");
    // and no PayPal routes remain mounted
    for (const url of [
      "/payments/send",
      `/swaps/${swapId}/invoice`,
      `/swaps/${swapId}/payout-sync`,
      "/webhooks/paypal",
    ]) {
      const gone = await a.inject({
        method: "POST",
        url,
        payload: signed(engine, engineDid, {}),
      });
      expect(gone.statusCode, url).toBe(404);
    }
  });

  it("lets the seller confirm from PAYMENT_PENDING (paid but unclaimed)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    // the seller sees the transfer land before the buyer uploads any proof —
    // the rescue hatch for a paid-but-unclaimed payment (docs/p2p.md §9)
    bump();
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("PAYMENT_VERIFIED");
  });

  it("cancel policy: the seller walks away only pre-instructions, the buyer only pre-claim", async () => {
    const a = await app();
    // pre-instructions the seller may walk away — nothing can have been paid yet
    const early = await toEscrowLocked(a);
    bump();
    const sellerEarly = await a.inject({
      method: "POST",
      url: `/swaps/${early}/transitions`,
      payload: signed(seller, sellerDid, {
        action: "cancel",
        requestMethod: "POST",
        requestPath: `/swaps/${early}/transitions`,
      }),
    });
    expect(sellerEarly.statusCode).toBe(200);
    expect((await store.getSwap(early))!.status).toBe("CANCELLED");

    // after instructions only the buyer — the party who knows whether they
    // paid — may cancel
    const late = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${late}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${late}/payment-instructions`,
      }),
    });
    bump();
    const sellerLate = await a.inject({
      method: "POST",
      url: `/swaps/${late}/transitions`,
      payload: signed(seller, sellerDid, {
        action: "cancel",
        requestMethod: "POST",
        requestPath: `/swaps/${late}/transitions`,
      }),
    });
    expect(sellerLate.statusCode).toBe(409);
    const buyerCancel = await a.inject({
      method: "POST",
      url: `/swaps/${late}/transitions`,
      payload: signed(buyer, buyerDid, {
        action: "cancel",
        requestMethod: "POST",
        requestPath: `/swaps/${late}/transitions`,
      }),
    });
    expect(buyerCancel.statusCode).toBe(200);
    expect((await store.getSwap(late))!.status).toBe("CANCELLED");
  });

  it("a payment claim bars cancel and seller expire (dispute is the only unwind)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    // cancel is dead for both parties once the buyer asserted a payment
    for (const [key, did] of [
      [seller, sellerDid],
      [buyer, buyerDid],
    ] as const) {
      bump();
      const r = await a.inject({
        method: "POST",
        url: `/swaps/${swapId}/transitions`,
        payload: signed(key, did, {
          action: "cancel",
          requestMethod: "POST",
          requestPath: `/swaps/${swapId}/transitions`,
        }),
      });
      expect(r.statusCode, did).toBe(409);
    }
    // and the seller cannot refund themselves over a live claim
    bump();
    const expire = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(seller, sellerDid, {
        action: "expire",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(expire.statusCode).toBe(409);
    expect(expire.json().error).toContain("payment claim in flight");

    // a confirmed payment is even more final: release is the only way out
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    bump();
    const cancelAfter = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(buyer, buyerDid, {
        action: "cancel",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/transitions`,
      }),
    });
    expect(cancelAfter.statusCode).toBe(409);
  });

  it("an open dispute freezes the unwind paths too (only arbitration moves)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(buyer, buyerDid, {
        reason: "paid to a wrong account",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/dispute`,
      }),
    });
    for (const [key, did, action] of [
      [seller, sellerDid, "expire"],
      [buyer, buyerDid, "cancel"],
    ] as const) {
      bump();
      const r = await a.inject({
        method: "POST",
        url: `/swaps/${swapId}/transitions`,
        payload: signed(key, did, {
          action,
          requestMethod: "POST",
          requestPath: `/swaps/${swapId}/transitions`,
        }),
      });
      expect(r.statusCode, action).toBe(422);
      expect(r.json().error).toContain("dispute OPEN");
    }
  });

  it("sweep: a silent pre-payment swap expires and refunds", async () => {
    const a = await app({
      SETTLEMENT_CNY_EXPIRE_AFTER: "60",
      SETTLEMENT_CNY_CONFIRM_TIMEOUT: "30",
    });
    const swapId = await toEscrowLocked(a);
    clock += 61_000;
    await sweepTick(a);
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("ESCROW_REFUNDED");
    // engine-act unwind on the log: expire → refund
    const tail = (await store.events(swapId)).map((e) => e.eventType).slice(-2);
    expect(tail).toEqual(["expire", "refund"]);
  });

  it("sweep: an unconfirmed claim opens a dispute — never an auto-refund over a claim", async () => {
    const a = await app({
      SETTLEMENT_CNY_CONFIRM_TIMEOUT: "30",
      SETTLEMENT_CNY_EXPIRE_AFTER: "60",
    });
    const swapId = await toEscrowLocked(a);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    clock += 31_000;
    await sweepTick(a);
    // the buyer may really have paid: the claim is never swept away, it goes
    // to arbitration (docs/p2p.md §12)
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("PAYMENT_CLAIMED");
    expect(stored.dispute).toBe("OPEN");
    expect(stored.disputeReason).toContain("auto:");
    // and the freeze routes even a late seller confirm to the arbiter
    bump();
    const confirm = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/confirm`,
      }),
    });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.json().error).toContain("dispute OPEN");
  });

  it("sweep: leaves disputed swaps to arbitration and verified swaps to the hook", async () => {
    const a = await app({
      SETTLEMENT_CNY_EXPIRE_AFTER: "60",
      SETTLEMENT_CNY_CONFIRM_TIMEOUT: "30",
    });
    // a disputed swap is arbitration's — no timer touches it
    const disputed = await toEscrowLocked(a);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${disputed}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${disputed}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${disputed}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${disputed}/proof`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${disputed}/dispute`,
      payload: signed(buyer, buyerDid, {
        reason: "review",
        requestMethod: "POST",
        requestPath: `/swaps/${disputed}/dispute`,
      }),
    });
    const before = (await store.getSwap(disputed))!;

    // PAYMENT_VERIFIED is the release hook's — the sweep must not expire it
    const verified = await toEscrowLocked(a);
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${verified}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${verified}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${verified}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-2",
        requestMethod: "POST",
        requestPath: `/swaps/${verified}/proof`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${verified}/confirm`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${verified}/confirm`,
      }),
    });

    clock += 600_000;
    await sweepTick(a);
    const after = (await store.getSwap(disputed))!;
    expect(after.status).toBe(before.status);
    expect(after.seq).toBe(before.seq);
    expect((await store.getSwap(verified))!.status).toBe("PAYMENT_VERIFIED");
  });

  it("signed arbiters: the token cannot resolve, a large dispute needs two distinct arbiters", async () => {
    const arb1 = Ed25519Key.createNewKey();
    const arb2 = Ed25519Key.createNewKey();
    const arb1Did = didFromEd25519Key(arb1);
    const arb2Did = didFromEd25519Key(arb2);
    const a = await app({
      SETTLEMENT_ADMIN_DIDS: `${arb1Did},${arb2Did}`,
      SETTLEMENT_DISPUTE_2ND_APPROVAL_ABOVE: "100",
    });
    const swapId = await toEscrowLocked(a);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(seller, sellerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/dispute`,
      }),
    });
    const path = `/swaps/${swapId}/dispute/resolve`;
    const byToken = await a.inject({
      method: "POST",
      url: path,
      headers: { "x-settlement-admin-token": "adm" },
      payload: { outcome: "refund" },
    });
    expect(byToken.statusCode).toBe(403);
    const byParty = await a.inject({
      method: "POST",
      url: path,
      payload: signed(seller, sellerDid, {
        outcome: "refund",
        requestMethod: "POST",
        requestPath: path,
      }),
    });
    expect(byParty.statusCode).toBe(403);
    bump();
    const first = await a.inject({
      method: "POST",
      url: path,
      payload: signed(arb1, arb1Did, {
        outcome: "refund",
        requestMethod: "POST",
        requestPath: path,
      }),
    });
    expect(first.statusCode).toBe(202);
    bump();
    const sameArbiter = await a.inject({
      method: "POST",
      url: path,
      payload: signed(arb1, arb1Did, {
        outcome: "refund",
        requestMethod: "POST",
        requestPath: path,
      }),
    });
    expect(sameArbiter.statusCode).toBe(202);
    expect((await store.getSwap(swapId))!.dispute).toBe("OPEN");
    bump();
    const second = await a.inject({
      method: "POST",
      url: path,
      payload: signed(arb2, arb2Did, {
        outcome: "refund",
        requestMethod: "POST",
        requestPath: path,
      }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      dispute: "RESOLVED",
      disputeOutcome: "refund",
    });
    const resolveEvent = (await store.events(swapId)).find(
      (e) => e.eventType === "dispute_resolve",
    )!;
    expect(resolveEvent.arbiterDid).toBe(arb2Did);
    expect(
      anchored.some(
        (e) => e.eventType === "dispute_resolve" && e.arbiterDid === arb2Did,
      ),
    ).toBe(true);
  });

  it("sweep: SETTLEMENT_DISPUTE_DEFAULT settles a dispute nobody arbitrated within the TTL", async () => {
    const a = await app({
      SETTLEMENT_DISPUTE_TTL: "3600",
      SETTLEMENT_DISPUTE_DEFAULT: "refund",
    });
    const swapId = await toEscrowLocked(a);
    bump();
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyer, buyerDid, {
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/payment-instructions`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyer, buyerDid, {
        txId: "TX-1",
        remark: ins.json().remark,
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/proof`,
      }),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(seller, sellerDid, {
        reason: "no money",
        requestMethod: "POST",
        requestPath: `/swaps/${swapId}/dispute`,
      }),
    });
    clock += 3_599_000;
    await sweepTick(a);
    expect((await store.getSwap(swapId))!.dispute).toBe("OPEN");
    clock += 2_000;
    await sweepTick(a);
    const stored = (await store.getSwap(swapId))!;
    expect(stored.dispute).toBe("RESOLVED");
    expect(stored.disputeOutcome).toBe("refund");
    expect(stored.status).toBe("ESCROW_REFUNDED");
  });
});
