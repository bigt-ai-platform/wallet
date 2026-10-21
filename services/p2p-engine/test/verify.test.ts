import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { validateP2pSwapRecord } from "p2p-protocol";
import { buildApp } from "../src/server.js";
import { swapEventRecord } from "../src/anchor.js";
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

async function saveProfile(a: TestApp) {
  const r = await a.inject({
    method: "POST",
    url: "/profiles",
    payload: signed(seller, sellerDid, { method: "wechat", accountName: "Zhang San", account: "wxid_pay888", requestMethod: "POST", requestPath: "/profiles" }),
  });
  expect(r.statusCode).toBe(200);
}

async function toEscrowLocked(a: TestApp): Promise<string> {
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
      wantRail: "wechat",
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

async function instructions(a: TestApp, swapId: string): Promise<string> {
  const ins = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/payment-instructions`,
    payload: signed(buyer, buyerDid, { requestMethod: "POST", requestPath: `/swaps/${swapId}/payment-instructions` }),
  });
  expect(ins.statusCode).toBe(201);
  bump();
  return ins.json().remark as string;
}

async function claim(a: TestApp, swapId: string, remark: string, txId = "4200001234567890") {
  const proof = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/proof`,
    payload: signed(buyer, buyerDid, { txId, remark, requestMethod: "POST", requestPath: `/swaps/${swapId}/proof` }),
  });
  expect(proof.statusCode).toBe(200);
  bump();
}

function verify(a: TestApp, swapId: string, payload: Record<string, unknown>) {
  return a.inject({ method: "POST", url: `/swaps/${swapId}/verify`, payload });
}

/** The buyer's device read: the sending app shows the completed transfer. */
function sentVerdict(remark: string, txId = "4200001234567890") {
  return {
    side: "buyer",
    observed: "sent",
    txId,
    amount: "715.00",
    remark,
    paidAt: clock,
    evidenceKind: "device_read",
    counterpartyName: "张三",
    captures: ["a".repeat(64)],
  };
}

/** The seller's device read: the receiving app shows the entry. */
function receivedVerdict(remark: string, txId = "4200001234567890") {
  return {
    side: "seller",
    observed: "received",
    txId,
    amount: "715",
    remark,
    paidAt: clock,
    evidenceKind: "device_read",
    captures: ["b".repeat(64)],
  };
}

beforeEach(async () => {
  clock = 1_700_000_000_000;
  store.orders.clear();
  store.swapEvents.clear();
  store.paymentProfiles.clear();
  store.paymentProofs.clear();
  store.paymentVerifications.clear();
  anchored.length = 0;
  await saveProfile(await app());
});

describe("device-side payment verification (docs/p2p.md §12)", () => {
  it("only the parties may file, and only their own side", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);

    const stranger = Ed25519Key.createNewKey();
    const strangerDid = didFromEd25519Key(stranger);
    const outsider = await verify(a, swapId, signed(stranger, strangerDid, { ...(sentVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(outsider.statusCode).toBe(403);

    // a party can never file the other side's story
    const wrongSide = await verify(a, swapId, signed(buyer, buyerDid, { ...(receivedVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(wrongSide.statusCode).toBe(422);
    expect(wrongSide.json().error).toMatch(/side must be buyer/);
  });

  it("fails closed on the four checks (amount, remark, window, id)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);

    const badAmount = await verify(a, swapId, signed(buyer, buyerDid, { ...sentVerdict(remark), amount: "714.99", requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(badAmount.statusCode).toBe(422);
    expect(badAmount.json().error).toMatch(/amount/);

    const badRemark = await verify(a, swapId, signed(buyer, buyerDid, { ...sentVerdict(remark), remark: "deadbeefdeadbeef", requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(badRemark.statusCode).toBe(422);
    expect(badRemark.json().error).toMatch(/remark/);

    const oldTransfer = await verify(a, swapId, signed(buyer, buyerDid, { ...sentVerdict(remark), paidAt: 1, requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(oldTransfer.statusCode).toBe(422);
    expect(oldTransfer.json().error).toMatch(/window/);

    const badId = await verify(a, swapId, signed(buyer, buyerDid, { ...sentVerdict(remark), txId: "not valid!", requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(badId.statusCode).toBe(422);
    expect(badId.json().error).toMatch(/txId/);
  });

  it("is evidence-only under the default policy", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark);

    const buyerSide = await verify(a, swapId, signed(buyer, buyerDid, { ...(sentVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(buyerSide.statusCode).toBe(200);
    expect(buyerSide.json()).toMatchObject({ stored: true, side: "buyer", machineConfirmed: false, advanced: false });

    const sellerNone = await verify(
      a,
      swapId,
      signed(seller, sellerDid, { side: "seller", observed: "none", evidenceKind: "device_read", requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }),
    );
    expect(sellerNone.statusCode).toBe(200);
    expect((await store.getSwap(swapId))!.status).toBe("PAYMENT_CLAIMED");
    expect(await store.verifications(swapId)).toHaveLength(2);
  });

  it("seller_receipt: the seller's own ledger acts as the confirm", async () => {
    const a = await app({ SETTLEMENT_CNY_AUTO_RELEASE_ON: "seller_receipt" });
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark);

    const sellerSide = await verify(a, swapId, signed(seller, sellerDid, { ...(receivedVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(sellerSide.statusCode).toBe(200);
    expect(sellerSide.json()).toMatchObject({ machineConfirmed: true, advanced: true });
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("PAYMENT_VERIFIED");
    expect(stored.eventType).toBe("payment_confirm");
    expect(stored.verifySource).toBe("device_read");
    expect(stored.actorDid).toBe(sellerDid);
  });

  it("two_sided: both ledgers must agree on one 流水号", async () => {
    const a = await app({ SETTLEMENT_CNY_AUTO_RELEASE_ON: "two_sided" });
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark);

    // the seller's ledger alone does not qualify under the strict policy
    const sellerSide = await verify(a, swapId, signed(seller, sellerDid, { ...(receivedVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(sellerSide.json()).toMatchObject({ machineConfirmed: false, advanced: false });

    const buyerSide = await verify(a, swapId, signed(buyer, buyerDid, { ...(sentVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(buyerSide.statusCode).toBe(200);
    expect(buyerSide.json()).toMatchObject({ machineConfirmed: true, advanced: true });
    expect((await store.getSwap(swapId))!.status).toBe("PAYMENT_VERIFIED");

    // a different 流水号 on the two sides is two stories, not verification
    const other = await toEscrowLocked(a);
    const otherRemark = await instructions(a, other);
    await claim(a, other, otherRemark);
    await verify(a, other, signed(seller, sellerDid, { ...(receivedVerdict(otherRemark)), requestMethod: "POST", requestPath: `/swaps/${other}/verify` }));
    const disagree = await verify(a, other, signed(buyer, buyerDid, { ...(sentVerdict(otherRemark, "9900000000000000")), requestMethod: "POST", requestPath: `/swaps/${other}/verify` }));
    expect(disagree.json()).toMatchObject({ machineConfirmed: false, advanced: false });
    expect((await store.getSwap(other))!.status).toBe("PAYMENT_CLAIMED");
  });

  it("surfaces a claim/observation 流水号 mismatch as evidence", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark, "TX-1");

    const v = await verify(a, swapId, signed(buyer, buyerDid, { ...(sentVerdict(remark, "TX-2")), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(v.statusCode).toBe(200);
    expect(v.json().claimMismatch).toEqual({ claimed: "TX-1", observed: "TX-2" });
    expect(await store.verifications(swapId)).toHaveLength(1);
  });

  it("a frozen swap stores the verdict but never advances", async () => {
    const a = await app({ SETTLEMENT_CNY_AUTO_RELEASE_ON: "seller_receipt" });
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark);
    const opened = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/dispute`,
      payload: signed(buyer, buyerDid, { reason: "review", requestMethod: "POST", requestPath: `/swaps/${swapId}/dispute` }),
    });
    expect(opened.statusCode).toBe(200);
    bump();

    const sellerSide = await verify(a, swapId, signed(seller, sellerDid, { ...(receivedVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    expect(sellerSide.statusCode).toBe(200);
    expect(sellerSide.json()).toMatchObject({ stored: true, advanced: false });
    expect((await store.getSwap(swapId))!.status).toBe("PAYMENT_CLAIMED");
  });

  it("anchors the verdict minus PII (small evidence on chain; bytes only as hashes)", async () => {
    const a = await app({ SETTLEMENT_CNY_AUTO_RELEASE_ON: "seller_receipt" });
    const swapId = await toEscrowLocked(a);
    const remark = await instructions(a, swapId);
    await claim(a, swapId, remark);

    await verify(a, swapId, signed(buyer, buyerDid, { ...(sentVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));
    await verify(a, swapId, signed(seller, sellerDid, { ...(receivedVerdict(remark)), requestMethod: "POST", requestPath: `/swaps/${swapId}/verify` }));

    const events = await store.events(swapId);
    const verifyEvent = events.find((e) => e.eventType === "payment_verify")!;
    expect(verifyEvent.verify).toBeTruthy();
    // the counterparty name is PII: it lives in the verification store only
    expect(verifyEvent.verify).not.toHaveProperty("counterpartyName");
    expect((await store.verifications(swapId))[0].counterpartyName).toBe("张三");

    // the anchored record carries the small evidence and the capture hashes
    const record = swapEventRecord(verifyEvent, engineDid);
    expect(validateP2pSwapRecord(record)).toEqual({ ok: true });
    expect(record).toMatchObject({
      verifySide: "buyer",
      verifyObserved: "sent",
      verifyTxId: "4200001234567890",
      verifyAmount: "715.00",
      verifyRemark: remark,
      verifyEvidence: "device_read",
    });
    expect(record.verifyCaptures).toBe("a".repeat(64));
    expect(record).not.toHaveProperty("counterpartyName");

    // and the machine confirm anchors how it was obtained
    const confirmEvent = events.find((e) => e.eventType === "payment_confirm")!;
    const confirmRecord = swapEventRecord(confirmEvent, engineDid);
    expect(confirmRecord.verifyEvidence).toBe("device_read");
    expect(confirmRecord).not.toHaveProperty("verifySide");
  });
});
