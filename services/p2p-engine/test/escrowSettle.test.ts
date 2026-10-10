import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  Address,
  Coin,
  ECKey,
  FreeStandingTransactionOutput,
  MainNetParams,
  PQKey,
  Script,
  ScriptBuilder,
  Sha256Hash,
  SigHash,
  Transaction,
  UTXO,
  Utils,
  escrowSpendAmount,
} from "bigtangle-ts";
import { didFromPQKey } from "did/pq";
import type { SettlementOutput } from "p2p-protocol";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, canonicalJson } from "../src/sign.js";
import { escrowAddress, escrowOutputScript } from "../src/escrow.js";
import { awaitConfirmed, buildSkeleton, vaultFor } from "../src/escrowSpend.js";
import type { ChainClient, ChainStatus, RawUtxo } from "../src/chain.js";
import type { P2pSwapEvent } from "../src/types.js";

const params = MainNetParams.get();

/** Deterministic 32-byte ML-DSA seeds (same pattern as bigtangle-ts EscrowTest). */
function pqKey(seedByte: number): PQKey {
  const seed = new Uint8Array(32);
  seed[31] = seedByte;
  return PQKey.fromKeyMaterial(seed);
}

const sellerKey = pqKey(21);
const buyerKey = pqKey(22);
const engineKey = pqKey(23);
const strangerKey = pqKey(24);
const wrongEngineKey = pqKey(99);

const sellerDid = didFromPQKey(sellerKey);
const buyerDid = didFromPQKey(buyerKey);
const engineDidStr = didFromPQKey(engineKey);
const strangerDid = didFromPQKey(strangerKey);

const ENGINE_PUB = Utils.HEX.encode(engineKey.getPrefixedPublicKeyBytes());
const ENGINE_SEED = engineKey.getPrivateKeySeedAsHex();
const WRONG_ENGINE_SEED = wrongEngineKey.getPrivateKeySeedAsHex();
const WRONG_ENGINE_PUB = Utils.HEX.encode(wrongEngineKey.getPrefixedPublicKeyBytes());
if (!ENGINE_SEED || !WRONG_ENGINE_SEED) throw new Error("test PQ keys expose no private seed");

const receiveAddress = ECKey.createNewKey().toAddress(params).toBase58();
const refundAddress = ECKey.createNewKey().toAddress(params).toBase58();

const vault = vaultFor(sellerDid, buyerDid, ENGINE_PUB)!;
const escrowAddr = escrowAddress([sellerKey, buyerKey, engineKey], 2);
const outputScript = escrowOutputScript(2, [sellerKey, buyerKey, engineKey]);
const blockHash = Sha256Hash.wrapString("bb".repeat(32));

/** The lock transaction: one P2SH output holding BIG 0.01 at the escrow address. */
const funding = new Transaction(params);
funding.addOutputScript(Coin.COIN, outputScript);
const lockTxHash = funding.getHash().toString();

const utxoJson: RawUtxo = {
  value: { value: "1000000", tokenHex: "bc" },
  scriptHex: Utils.HEX.encode(outputScript.getProgram()),
  hashHex: lockTxHash,
  blockHashHex: blockHash.toString(),
  index: 0,
  address: escrowAddr,
  spent: false,
  confirmed: true,
};

/**
 * Chain fake: the lock is CONFIRMED at the escrow address with the locked
 * balance; anything else behaves like a freshly broadcast spend — status comes
 * from `spendStatus`, the destination from `spendTo` (what getTransactionStatus
 * derives: the first output address).
 */
class MockChain implements ChainClient {
  submitted: string[] = [];
  spendTo: string | null = null;
  spendStatus = "CONFIRMED";
  hideUtxo = false;
  submitError: string | null = null;

  constructor(
    private readonly lockAddress: string,
    private readonly lockHash: string,
    private readonly lockBalances: SettlementOutput[],
  ) {}

  async transactionStatus(txHash: string): Promise<ChainStatus> {
    if (txHash === this.lockHash) return { status: "CONFIRMED", address: this.lockAddress };
    return { status: this.spendStatus, address: this.spendTo ?? undefined };
  }

  async balances(): Promise<SettlementOutput[]> {
    return this.lockBalances;
  }

  async outputsHistory(address: string): Promise<RawUtxo[]> {
    return !this.hideUtxo && address === this.lockAddress ? [utxoJson] : [];
  }

  async submitTransaction(rawTxHex: string): Promise<void> {
    if (this.submitError) throw new Error(this.submitError);
    this.submitted.push(rawTxHex);
  }
}

function makeChain(): MockChain {
  return new MockChain(escrowAddr, lockTxHash, [
    { address: escrowAddr, token: "BIG", amount: "1000000", spent: false, confirmed: true },
  ]);
}

let clock = 1_700_000_000_000;
const store = new MemSettlementStore();
const anchored: P2pSwapEvent[] = [];

function bump() {
  clock += 1;
}

/** PQ did:key signed body — the exact shape `validateSignedRequest` verifies. */
function signed(key: PQKey, did: string, fields: Record<string, unknown>) {
  const payload = { ...fields, did, nonce: randomBytes(8).toString("hex"), timestamp: clock };
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonicalJson(payload)));
  return { ...payload, signature: Utils.HEX.encode(key.sign(Sha256Hash.wrap(digest)).serialize()) };
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function app(chain: MockChain | null, extraEnv: NodeJS.ProcessEnv = {}): Promise<TestApp> {
  return buildApp({
    store,
    env: {
      SETTLEMENT_ENGINE_DID: engineDidStr,
      SETTLEMENT_ENGINE_KEY: ENGINE_SEED,
      SETTLEMENT_ENGINE_PUBKEY: ENGINE_PUB,
      SETTLEMENT_ADMIN_TOKEN: "adm",
      SETTLEMENT_ESCROW_POLL_MS: "0",
      ...extraEnv,
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    paypal: {
      createInvoice: async () => ({ id: "INV-1", url: "https://paypal.test/i/INV-1" }),
      sendInvoice: async () => {},
      createPayout: async () => ({ id: "PO-1", itemId: "PI-1" }),
      getPayout: async () => ({ status: "SUCCESS", itemId: "PI-1" }),
    },
    chain,
    now: () => clock,
    verifyWebhook: async () => true,
    anchor: async (e) => {
      anchored.push(e);
      return { txid: "a".repeat(64) };
    },
  });
}

async function saveProfile(a: TestApp): Promise<void> {
  const r = await a.inject({
    method: "POST",
    url: "/profiles",
    payload: signed(sellerKey, sellerDid, {
      method: "wechat",
      accountName: "Zhang San",
      account: "wxid_pay888",
    }),
  });
  expect(r.statusCode).toBe(200);
}

/** Order → match → escrow_lock against the mock chain (CONFIRMED lock). */
async function toEscrowLocked(a: TestApp): Promise<string> {
  const r1 = await a.inject({
    method: "POST",
    url: "/orders",
    payload: signed(sellerKey, sellerDid, {
      type: "limit_sell",
      sellerDid,
      giveToken: "BIG",
      giveAmount: "1000000",
      giveChain: "L0",
      wantCurrency: "CNY",
      wantAmount: "715",
      wantRail: "wechat",
      validUntil: Math.floor(clock / 1000) + 3600,
    }),
  });
  expect(r1.statusCode).toBe(201);
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${r1.json().orderId}/match`,
    payload: signed(buyerKey, buyerDid, { buyerDid, receiveAddress }),
  });
  expect(r2.statusCode).toBe(201);
  expect(r2.json().escrowAddress).toBe(escrowAddr);
  const swapId = r2.json().swapId as string;
  bump();
  const lock = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(sellerKey, sellerDid, { action: "escrow_lock", txHash: lockTxHash }),
  });
  expect(lock.statusCode).toBe(200);
  expect(lock.json().status).toBe("ESCROW_LOCKED");
  bump();
  return swapId;
}

/** CNY payment leg: instructions → proof → confirm → PAYMENT_VERIFIED. */
async function toPaymentVerified(a: TestApp, swapId: string): Promise<void> {
  const ins = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/payment-instructions`,
    payload: signed(buyerKey, buyerDid, {}),
  });
  expect(ins.statusCode).toBe(201);
  bump();
  const proof = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/proof`,
    payload: signed(buyerKey, buyerDid, {
      txId: "4200001234567890",
      remark: ins.json().remark,
      receipt: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    }),
  });
  expect(proof.statusCode).toBe(200);
  bump();
  const confirm = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/confirm`,
    payload: signed(sellerKey, sellerDid, {}),
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json().status).toBe("PAYMENT_VERIFIED");
  bump();
}

async function presign(a: TestApp, swapId: string) {
  const release = await buildSkeleton({
    chain: makeChain(),
    vault,
    escrowAddress: escrowAddr,
    escrowTxHash: lockTxHash,
    to: Address.fromBase58(params, receiveAddress),
  });
  const refund = await buildSkeleton({
    chain: makeChain(),
    vault,
    escrowAddress: escrowAddr,
    escrowTxHash: lockTxHash,
    to: Address.fromBase58(params, refundAddress),
  });
  expect(release).not.toBeNull();
  expect(refund).not.toBeNull();
  return {
    releaseSkel: release!,
    refundSkel: refund!,
    releaseSig: Utils.HEX.encode(sellerKey.sign(release!.sighash).serialize()),
    refundSig: Utils.HEX.encode(sellerKey.sign(refund!.sighash).serialize()),
  };
}

async function presignRequest(a: TestApp, swapId: string, payload: Record<string, unknown>) {
  return a.inject({
    method: "POST",
    url: `/swaps/${swapId}/escrow/presign`,
    payload: signed(sellerKey, sellerDid, payload),
  });
}

function hookTick(a: TestApp): Promise<void> {
  return (a as unknown as { escrowHookTick: () => Promise<void> }).escrowHookTick();
}

/** The broadcast spend: parses, script-verifies, and asserts value + destination. */
async function expectSpendTx(rawHex: string, toBase58: string): Promise<Transaction> {
  const parsed = params.getDefaultSerializer().makeTransaction(Utils.HEX.decode(rawHex));
  await parsed.getInput(0)
    .getScriptSig()
    .correctlySpends(parsed, 0, outputScript, Script.ALL_VERIFY_FLAGS);
  const out = parsed.getOutputs()[0];
  expect(out.getValue().getValue().toString()).toBe("999000"); // 1_000_000 − FEE_DEFAULT
  expect(Utils.HEX.encode(out.getScriptPubKey().getProgram())).toBe(
    Utils.HEX.encode(
      ScriptBuilder.createOutputScript(Address.fromBase58(params, toBase58)).getProgram(),
    ),
  );
  return parsed;
}

beforeEach(async () => {
  clock = 1_700_000_000_000;
  store.orders.clear();
  store.swapEvents.clear();
  store.paymentProfiles.clear();
  store.paymentProofs.clear();
  store.escrowSignings.clear();
  anchored.length = 0;
  await saveProfile(await app(null));
});

describe("escrow spend helpers", () => {
  it("escrowSpendAmount: BIG loses the default fee, other tokens pay out in full", () => {
    expect(escrowSpendAmount(Coin.fromJSON({ value: "1000000", tokenHex: "bc" })).getValue()).toBe(999000n);
    expect(escrowSpendAmount(Coin.fromJSON({ value: "5000", tokenHex: "01" })).getValue()).toBe(5000n);
    expect(() => escrowSpendAmount(Coin.fromJSON({ value: "500", tokenHex: "bc" }))).toThrow(
      /below the default fee/,
    );
  });

  it("wallet-style and engine-style skeleton rebuilds are byte-identical", async () => {
    const chain = makeChain();
    const skel = await buildSkeleton({
      chain,
      vault,
      escrowAddress: escrowAddr,
      escrowTxHash: lockTxHash,
      to: Address.fromBase58(params, receiveAddress),
    });
    expect(skel).not.toBeNull();
    // The wallet's path: the raw getOutputsHistory JSON, rebuilt locally with
    // the same shared rules (UTXO → detached outpoint → escrowSpendAmount).
    const utxo = UTXO.fromJSONObject(utxoJson);
    const walletTx = vault.createSpend({
      params,
      blockHash: utxo.getBlockHash()!,
      utxo: new FreeStandingTransactionOutput(params, utxo),
      to: Address.fromBase58(params, receiveAddress),
      amount: escrowSpendAmount(utxo.getValue()),
    });
    expect(Utils.HEX.encode(skel!.tx.bitcoinSerialize())).toBe(
      Utils.HEX.encode(walletTx.bitcoinSerialize()),
    );
    expect(skel!.sighash.toString()).toBe(
      walletTx.hashForSignature(0, vault.redeemScript.getProgram(), SigHash.ALL, false).toString(),
    );
    expect(skel!.amount.getValue().toString()).toBe("999000");
  });

  it("awaitConfirmed: DROPPED is terminal, unreachable L0 never throws", async () => {
    const to = Address.fromBase58(params, receiveAddress);
    const stub = (status: string | Error, address?: string): ChainClient => ({
      transactionStatus: async (): Promise<ChainStatus> => {
        if (status instanceof Error) throw status;
        return { status, address };
      },
      balances: async () => [],
      outputsHistory: async () => [],
      submitTransaction: async () => {},
    });
    const dropped = await awaitConfirmed(stub("DROPPED"), "h", to, { pollMs: 0, intervalMs: 0 });
    expect(dropped.confirmed).toBe(false);
    expect(dropped.status).toBe("DROPPED");
    const down = await awaitConfirmed(stub(new Error("ECONNREFUSED")), "h", to, {
      pollMs: 0,
      intervalMs: 0,
    });
    expect(down.confirmed).toBe(false);
    expect(down.reason).toMatch(/timeout|unreachable/);
    const wrongTo = await awaitConfirmed(
      stub("CONFIRMED", receiveAddress),
      "h",
      Address.fromBase58(params, refundAddress),
      { pollMs: 0, intervalMs: 0 },
    );
    expect(wrongTo.confirmed).toBe(false);
    expect(wrongTo.reason).toMatch(/pays/);
  });
});

describe("capabilities", () => {
  it("advertises the engine's escrow pubkey so the wallet can rebuild the vault", async () => {
    const a = await app(makeChain());
    const caps = await a.inject({ method: "GET", url: "/capabilities" });
    expect(caps.statusCode).toBe(200);
    expect(caps.json().escrowPubkey).toBe(ENGINE_PUB);
    expect(caps.json().escrow).toBe(true);
  });
});

describe("Path A — party cosign", () => {
  it("releases to the buyer at PAYMENT_VERIFIED and completes the CNY swap", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    await toPaymentVerified(a, swapId);

    const skel = await buildSkeleton({
      chain,
      vault,
      escrowAddress: escrowAddr,
      escrowTxHash: lockTxHash,
      to: Address.fromBase58(params, receiveAddress),
    });
    const buyerSig = Utils.HEX.encode(buyerKey.sign(skel!.sighash).serialize());
    bump();
    const cosign = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(buyerKey, buyerDid, { kind: "release", sig: buyerSig }),
    });
    expect(cosign.statusCode).toBe(200);
    expect(cosign.json()).toMatchObject({ status: "COMPLETED", pending: false });
    expect(chain.submitted).toHaveLength(1);

    const parsed = await expectSpendTx(chain.submitted[0], receiveAddress);
    expect(cosign.json().txHash).toBe(parsed.getHash().toString());

    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("COMPLETED");
    expect(stored.releaseTxHash).toBe(parsed.getHash().toString());
    expect(stored.eventType).toBe("complete");
    const row = (await store.getEscrowSigning(swapId))!;
    expect(row.releaseTxHash).toBe(parsed.getHash().toString());
    expect(row.releaseSignerDid).toBe(buyerDid);

    // Lost response → the retry reports the finished spend, not a conflict.
    bump();
    const retry = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(buyerKey, buyerDid, { kind: "release", sig: buyerSig }),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe("COMPLETED");
    expect(retry.json().txHash).toBe(parsed.getHash().toString());
    expect(chain.submitted).toHaveLength(1);
  });

  it("refunds to the seller at EXPIRED and refuses a buyer-signed refund", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);

    // A refund is only reachable from EXPIRED (state.ts), and it is the
    // seller's act: the buyer's refund attempt never reaches the signer check.
    const buyerRefund = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(buyerKey, buyerDid, { kind: "refund", sig: "00", refundAddress }),
    });
    expect(buyerRefund.statusCode).toBe(403);

    const expire = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(sellerKey, sellerDid, { action: "expire" }),
    });
    expect(expire.statusCode).toBe(200);
    expect(expire.json().status).toBe("EXPIRED");
    bump();

    const skel = await buildSkeleton({
      chain,
      vault,
      escrowAddress: escrowAddr,
      escrowTxHash: lockTxHash,
      to: Address.fromBase58(params, refundAddress),
    });
    const sellerSig = Utils.HEX.encode(sellerKey.sign(skel!.sighash).serialize());
    const cosign = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(sellerKey, sellerDid, { kind: "refund", sig: sellerSig, refundAddress }),
    });
    expect(cosign.statusCode).toBe(200);
    expect(cosign.json()).toMatchObject({ status: "ESCROW_REFUNDED", pending: false });
    expect(chain.submitted).toHaveLength(1);

    const parsed = await expectSpendTx(chain.submitted[0], refundAddress);
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("ESCROW_REFUNDED");
    expect(stored.refundTxHash).toBe(parsed.getHash().toString());
    expect((await store.getEscrowSigning(swapId))!.refundTxHash).toBe(parsed.getHash().toString());
  });

  it("fails closed on a bad signature, a non-party, and a vault mismatch", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    await toPaymentVerified(a, swapId);

    const { refundSkel } = await presign(a, swapId);
    const wrongSig = Utils.HEX.encode(sellerKey.sign(refundSkel.sighash).serialize());
    bump();
    const bad = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(sellerKey, sellerDid, { kind: "release", sig: wrongSig }),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatch(/does not verify/);

    bump();
    const outsider = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(strangerKey, strangerDid, { kind: "release", sig: wrongSig }),
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toMatch(/not a swap party/);
    expect(chain.submitted).toHaveLength(0);

    // Config drift after the lock: a rebuilt vault no longer pays the funded
    // address — the engine must refuse rather than spend to a different script.
    const drifted = await app(chain, {
      SETTLEMENT_ENGINE_DID: didFromPQKey(wrongEngineKey),
      SETTLEMENT_ENGINE_KEY: WRONG_ENGINE_SEED,
      SETTLEMENT_ENGINE_PUBKEY: WRONG_ENGINE_PUB,
    });
    const skel = await buildSkeleton({
      chain,
      vault,
      escrowAddress: escrowAddr,
      escrowTxHash: lockTxHash,
      to: Address.fromBase58(params, receiveAddress),
    });
    const sig = Utils.HEX.encode(buyerKey.sign(skel!.sighash).serialize());
    bump();
    const mismatch = await drifted.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(buyerKey, buyerDid, { kind: "release", sig }),
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toMatch(/does not match the vault/);
    expect(chain.submitted).toHaveLength(0);

    // KEY/PUBKEY disagreement inside one engine: engineSigner refuses to sign.
    const inconsistent = await app(chain, { SETTLEMENT_ENGINE_PUBKEY: WRONG_ENGINE_PUB });
    bump();
    const conf = await inconsistent.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/cosign`,
      payload: signed(buyerKey, buyerDid, { kind: "release", sig }),
    });
    expect(conf.statusCode).toBe(503);
    expect(conf.json().error).toMatch(/does not match SETTLEMENT_ENGINE_PUBKEY/);
    expect(chain.submitted).toHaveLength(0);
  });
});

describe("presign (seller locks both spend paths at escrow_lock)", () => {
  it("stores both verified signatures and the chosen refund address", async () => {
    const a = await app(makeChain());
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);

    const ok = await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ swapId, presigned: true, refundAddress });

    const row = (await store.getEscrowSigning(swapId))!;
    expect(row.releaseSig).toBe(releaseSig);
    expect(row.refundSig).toBe(refundSig);
    expect(row.refundAddress).toBe(refundAddress);
    expect(row.releaseSignerDid).toBe(sellerDid);
    expect(row.refundSignerDid).toBe(sellerDid);
  });

  it("rejects a signature over the wrong skeleton (422), a non-seller (403), a lockless swap (409)", async () => {
    const a = await app(makeChain());
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);

    const tampered = await presignRequest(a, swapId, {
      releaseSig: refundSig,
      refundSig,
      refundAddress,
    });
    expect(tampered.statusCode).toBe(422);
    expect(tampered.json().error).toMatch(/releaseSig does not verify/);

    const r2 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(sellerKey, sellerDid, {
        sellerDid,
        giveToken: "BIG",
        giveAmount: "1000000",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r3 = await a.inject({
      method: "POST",
      url: `/orders/${r2.json().orderId}/match`,
      payload: signed(buyerKey, buyerDid, { buyerDid, receiveAddress }),
    });
    const unlocked = r3.json().swapId as string;
    bump();
    const byBuyer = await a.inject({
      method: "POST",
      url: `/swaps/${unlocked}/escrow/presign`,
      payload: signed(buyerKey, buyerDid, { releaseSig, refundSig, refundAddress }),
    });
    expect(byBuyer.statusCode).toBe(403);

    const beforeLock = await presignRequest(a, unlocked, { releaseSig, refundSig, refundAddress });
    expect(beforeLock.statusCode).toBe(409);
    expect(beforeLock.json().error).toMatch(/no locked escrow/);
  });

  it("is unavailable without a chain client and when the lock output is invisible", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);

    const noChain = await app(null);
    const off = await presignRequest(noChain, swapId, { releaseSig, refundSig, refundAddress });
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toMatch(/chain not configured/);

    chain.hideUtxo = true;
    const hidden = await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json().error).toMatch(/escrow output not found/);
  });
});

describe("escrow context (party-scoped signing reveal)", () => {
  it("reveals receiveAddress + lock outpoint to a party, with the presigned arm state", async () => {
    const a = await app(makeChain());
    const swapId = await toEscrowLocked(a);

    const ctx = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/context`,
      payload: signed(buyerKey, buyerDid, { swapId }),
    });
    expect(ctx.statusCode).toBe(200);
    expect(ctx.json()).toEqual({
      swapId,
      escrowAddress: escrowAddr,
      escrowTxHash: lockTxHash,
      receiveAddress,
      sellerDid,
      buyerDid,
      presigned: false,
    });

    // The wallet view stays redacted (server.test contract) but carries the arm state.
    const view = await a.inject({
      method: "POST",
      url: "/swaps/mine",
      payload: signed(buyerKey, buyerDid, {}),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().swaps[0].receiveAddress).toBeUndefined();
    expect(view.json().swaps[0].presigned).toBe(false);

    const { releaseSig, refundSig } = await presign(a, swapId);
    bump();
    const pre = await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    expect(pre.statusCode).toBe(200);

    const after = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/context`,
      payload: signed(sellerKey, sellerDid, { swapId }),
    });
    expect(after.json().presigned).toBe(true);
    const sellerView = await a.inject({
      method: "POST",
      url: "/swaps/get",
      payload: signed(sellerKey, sellerDid, { swapId }),
    });
    expect(sellerView.json().swap.presigned).toBe(true);
    expect(sellerView.json().swap.receiveAddress).toBeUndefined();
  });

  it("fails closed: non-party 403, missing signature 400, lockless 409", async () => {
    const a = await app(makeChain());
    const swapId = await toEscrowLocked(a);

    const outsider = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/context`,
      payload: signed(strangerKey, strangerDid, { swapId }),
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error).toMatch(/not a swap party/);

    const unsigned = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/escrow/context`,
      payload: { swapId, did: buyerDid, nonce: "n", timestamp: clock },
    });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);

    const r1 = await a.inject({
      method: "POST",
      url: "/orders",
      payload: signed(sellerKey, sellerDid, {
        sellerDid,
        giveToken: "BIG",
        giveAmount: "1000000",
        giveChain: "L0",
        wantCurrency: "CNY",
        wantAmount: "715",
        wantRail: "wechat",
        validUntil: Math.floor(clock / 1000) + 3600,
      }),
    });
    bump();
    const r2 = await a.inject({
      method: "POST",
      url: `/orders/${r1.json().orderId}/match`,
      payload: signed(buyerKey, buyerDid, { buyerDid, receiveAddress }),
    });
    const unlocked = r2.json().swapId as string;
    bump();
    const lockless = await a.inject({
      method: "POST",
      url: `/swaps/${unlocked}/escrow/context`,
      payload: signed(sellerKey, sellerDid, { swapId: unlocked }),
    });
    expect(lockless.statusCode).toBe(409);
    expect(lockless.json().error).toMatch(/no locked escrow/);
  });
});

describe("escrow settlement hook (Path B)", () => {
  it("releases a presigned swap at PAYMENT_VERIFIED and ignores the second tick", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);
    const pre = await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    expect(pre.statusCode).toBe(200);
    await toPaymentVerified(a, swapId);

    await hookTick(a);
    expect(chain.submitted).toHaveLength(1);
    const parsed = await expectSpendTx(chain.submitted[0], receiveAddress);
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("COMPLETED");
    expect(stored.releaseTxHash).toBe(parsed.getHash().toString());

    await hookTick(a);
    expect(chain.submitted).toHaveLength(1);
  });

  it("refunds a presigned swap at EXPIRED", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);
    const pre = await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    expect(pre.statusCode).toBe(200);
    const expire = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/transitions`,
      payload: signed(sellerKey, sellerDid, { action: "expire" }),
    });
    expect(expire.statusCode).toBe(200);
    bump();

    await hookTick(a);
    expect(chain.submitted).toHaveLength(1);
    const parsed = await expectSpendTx(chain.submitted[0], refundAddress);
    const stored = (await store.getSwap(swapId))!;
    expect(stored.status).toBe("ESCROW_REFUNDED");
    expect(stored.refundTxHash).toBe(parsed.getHash().toString());
  });

  it("never touches a swap without a stored presign (e2e/manual flows stay manual)", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    await toPaymentVerified(a, swapId);

    await hookTick(a);
    expect(chain.submitted).toHaveLength(0);
    expect(((await store.getSwap(swapId))!).status).toBe("PAYMENT_VERIFIED");
    expect((await store.getEscrowSigning(swapId))).toBeNull();
  });

  it("leaves PAYMENT_CLAIMED alone (not yet verified)", async () => {
    const chain = makeChain();
    const a = await app(chain);
    const swapId = await toEscrowLocked(a);
    const { releaseSig, refundSig } = await presign(a, swapId);
    await presignRequest(a, swapId, { releaseSig, refundSig, refundAddress });
    const ins = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/payment-instructions`,
      payload: signed(buyerKey, buyerDid, {}),
    });
    bump();
    await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/proof`,
      payload: signed(buyerKey, buyerDid, {
        txId: "4200001234567890",
        remark: ins.json().remark,
        receipt: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }),
    });
    bump();

    await hookTick(a);
    expect(chain.submitted).toHaveLength(0);
    expect(((await store.getSwap(swapId))!).status).toBe("PAYMENT_CLAIMED");
  });
});
