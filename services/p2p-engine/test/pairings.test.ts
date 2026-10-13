import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp, type DeviceReadArgs, type DeviceReadResult } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";

/**
 * Device pairing + engine-driven read (docs/p2p.md §12). Locks in *who may
 * trigger a verification*: only a swap party, only their own side, only through
 * their own (unrevoked, unexpired, in-scope) pairing — never a stranger, never
 * the other side, never someone else's endpoint.
 */
const seller = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);

let clock = 1_700_000_000_000;
const store = new MemSettlementStore();

function signed(key: Ed25519Key, did: string, fields: Record<string, unknown>) {
  const payload = { ...fields, did, nonce: randomBytes(8).toString("hex"), timestamp: clock };
  return { ...payload, signature: signPayload(payload, key.getPrivHex()!) };
}

/** Records every read the engine was asked to perform. */
const reads: DeviceReadArgs[] = [];

async function app(extraEnv: NodeJS.ProcessEnv = {}) {
  return buildApp({
    store,
    env: { SETTLEMENT_ENGINE_DID: engineDid, SETTLEMENT_ADMIN_TOKEN: "adm", ...extraEnv } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    chain: null,
    now: () => clock,
    anchor: async () => ({ txid: "a".repeat(64) }),
    readDevice: async (args): Promise<DeviceReadResult> => {
      reads.push(args);
      const verdict = {
        side: args.side,
        observed: args.side === "buyer" ? "sent" : "received",
        evidenceKind: args.evidenceKind,
        txId: "4200001234567890",
        amount: args.expected.amount,
        ...(args.expected.remark ? { remark: args.expected.remark } : {}),
      };
      return { verdict, check: { ok: true }, captures: [], entry: null } as unknown as DeviceReadResult;
    },
  });
}

const bump = () => { clock += 1; };
type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function toEscrowLocked(a: TestApp): Promise<string> {
  const r1 = await a.inject({
    method: "POST",
    url: "/orders",
    payload: signed(seller, sellerDid, {
      type: "limit_sell", sellerDid, giveToken: "USDT", giveAmount: "100", giveChain: "L0",
      wantCurrency: "CNY", wantAmount: "715", wantRail: "wechat", validUntil: Math.floor(clock / 1000) + 3600,
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

function pairingId(): string {
  return `pr-${randomBytes(12).toString("hex")}`;
}

async function pair(a: TestApp, key: Ed25519Key, did: string, opts: { swapId?: string; ttlMs?: number } = {}) {
  const id = pairingId();
  const r = await a.inject({
    method: "POST",
    url: "/pairings",
    payload: signed(key, did, {
      pairingId: id,
      endpoint: "http://192.168.1.20:8080",
      deviceId: "self",
      token: "tok_" + randomBytes(4).toString("hex"),
      ...(opts.swapId ? { swapId: opts.swapId } : {}),
      issuedAt: clock,
      expiresAt: clock + (opts.ttlMs ?? 24 * 60 * 60 * 1000),
    }),
  });
  return { id, status: r.statusCode, json: () => r.json() };
}

function deviceRead(a: TestApp, key: Ed25519Key, did: string, swapId: string, extra: Record<string, unknown> = {}) {
  return a.inject({ method: "POST", url: `/swaps/${swapId}/device-read`, payload: signed(key, did, { ...extra }) });
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  store.orders.clear();
  store.swapEvents.clear();
  store.paymentProfiles.clear();
  store.paymentProofs.clear();
  store.paymentVerifications.clear();
  store.pairings.clear();
  reads.length = 0;
});

describe("device pairing + engine read (docs/p2p.md §12)", () => {
  it("pairs a DID-signed grant and lists it back without the token", async () => {
    const a = await app();
    const p = await pair(a, buyer, buyerDid);
    expect(p.status).toBe(201);

    const mine = await a.inject({ method: "POST", url: "/pairings/mine", payload: signed(buyer, buyerDid, {}) });
    expect(mine.statusCode).toBe(200);
    const list = mine.json().pairings as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pairingId: p.id, deviceId: "self", tokenSet: true, revoked: false });
    expect(list[0]).not.toHaveProperty("token");
  });

  it("rejects a grant that is missing the endpoint / token", async () => {
    const a = await app();
    const bad = await a.inject({
      method: "POST",
      url: "/pairings",
      payload: signed(buyer, buyerDid, {
        pairingId: pairingId(), endpoint: "", deviceId: "self", token: "t", issuedAt: clock, expiresAt: clock + 1000,
      }),
    });
    expect(bad.statusCode).toBe(422);
  });

  it("only a swap party may trigger a device read", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    await pair(a, buyer, buyerDid, { swapId });

    const stranger = Ed25519Key.createNewKey();
    const outsider = await deviceRead(a, stranger, didFromEd25519Key(stranger), swapId);
    expect(outsider.statusCode).toBe(403);
    expect(reads).toHaveLength(0);
  });

  it("reads the caller's own pairing and own side (buyer → sent, seller → received)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const buyerPair = await pair(a, buyer, buyerDid, { swapId });
    const sellerPair = await pair(a, seller, sellerDid, { swapId });

    const b = await deviceRead(a, buyer, buyerDid, swapId, { pairingId: buyerPair.id });
    expect(b.statusCode).toBe(200);
    expect(b.json().side).toBe("buyer");
    expect(b.json().verdict).toMatchObject({ side: "buyer", observed: "sent" });
    expect(reads[0].grant.endpoint).toBe("http://192.168.1.20:8080");
    expect(reads[0].side).toBe("buyer");

    const s = await deviceRead(a, seller, sellerDid, swapId, { pairingId: sellerPair.id });
    expect(s.statusCode).toBe(200);
    expect(s.json().side).toBe("seller");
    expect(reads[1].side).toBe("seller");
  });

  it("fails 409 without an active pairing for this swap", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    // buyer has no pairing at all
    const none = await deviceRead(a, buyer, buyerDid, swapId);
    expect(none.statusCode).toBe(409);
    expect(reads).toHaveLength(0);

    // a pairing scoped to a *different* swap does not serve this one
    const other = await toEscrowLocked(a);
    await pair(a, buyer, buyerDid, { swapId: other });
    const scopedOut = await deviceRead(a, buyer, buyerDid, swapId);
    expect(scopedOut.statusCode).toBe(409);
    expect(reads).toHaveLength(0);
  });

  it("a revoked pairing can no longer reach the endpoint", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const p = await pair(a, buyer, buyerDid, { swapId });

    const rev = await a.inject({
      method: "POST", url: "/pairings/revoke", payload: signed(buyer, buyerDid, { pairingId: p.id }),
    });
    expect(rev.statusCode).toBe(200);

    const after = await deviceRead(a, buyer, buyerDid, swapId, { pairingId: p.id });
    expect(after.statusCode).toBe(409);
    expect(reads).toHaveLength(0);
  });

  it("an expired pairing is not usable", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    await pair(a, buyer, buyerDid, { swapId, ttlMs: 1000 });
    bump();
    clock += 60_000; // past the 1s grant ttl
    const expired = await deviceRead(a, buyer, buyerDid, swapId);
    expect(expired.statusCode).toBe(409);
    expect(reads).toHaveLength(0);
  });
});
