import { describe, it, expect } from "vitest";
import { PQKey } from "bigtangle-ts";
import { didFromPQKey, signChallengePQ } from "did/pq";
import { recordDigest, verifyRecordSig, type AnchoredRecord } from "record-sig";
import { p2pOrderRecord, p2pSwapRecord, type P2pOrderRecord, type P2pSwapRecord } from "p2p-protocol";
import { MemSettlementStore } from "../src/store.js";
import {
  MemCursorStore,
  syncOnce,
  replayVerify,
  type ChainBlockView,
  type ChainRecord,
  type SocialSource,
} from "../src/replay.js";

const sellerKey = PQKey.fromMLDSA(new Uint8Array(32).fill(11));
const engineKey = PQKey.fromMLDSA(new Uint8Array(32).fill(12));
const sellerDid = didFromPQKey(sellerKey);
const engineDid = didFromPQKey(engineKey);

function sign<T extends { sig?: string; sigScheme?: string }>(key: PQKey, record: T): T & { sig: string; sigScheme: string } {
  const sig = signChallengePQ(key, recordDigest(record as AnchoredRecord));
  return { ...record, sigScheme: "mldsa", sig };
}

function orderRec(overrides: Partial<P2pOrderRecordInput> = {}): P2pOrderRecord {
  const rec = p2pOrderRecord({
    from: sellerDid,
    to: "ord-0123456789abcdef",
    giveToken: "USDT",
    giveAmount: "100",
    giveChain: "L0",
    wantCurrency: "USD",
    wantAmount: "101",
    wantRail: "wechat",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    ts: Date.now(),
    ...overrides,
  } as P2pOrderRecordInput);
  return sign(sellerKey, rec);
}

type P2pOrderRecordInput = Parameters<typeof p2pOrderRecord>[0];

function swapRec(overrides: Partial<Parameters<typeof p2pSwapRecord>[0]> = {}): P2pSwapRecord {
  const rec = p2pSwapRecord({
    from: engineDid,
    to: "swap-0123456789abcdef",
    status: "MATCHED",
    swapSeq: 0,
    orderId: "ord-0123456789abcdef",
    sellerDid,
    buyerDid: "did:key:zBUYER",
    giveChain: "L0",
    giveToken: "USDT",
    giveAmount: "100",
    wantAmount: "101",
    wantRail: "wechat",
    wantCurrency: "USD",
    ts: Date.now(),
    ...overrides,
  });
  return sign(engineKey, rec);
}

/** Fake chain: blocks referenced by hash, genesis at height 0. */
function chain(blocks: Array<{ hash: string; height: number; prevHash: string; records: ChainRecord[] }>): SocialSource {
  const byHash = new Map(blocks.map((b) => [b.hash, b as ChainBlockView]));
  return {
    async head() {
      return { hash: blocks[blocks.length - 1].hash };
    },
    async blockByHash(hash: string) {
      return byHash.get(hash) ?? null;
    },
  };
}

const GENESIS = { hash: "h0", height: 0, prevHash: "0".repeat(64), records: [] as ChainRecord[] };

function block(hash: string, height: number, prevHash: string, records: ChainRecord[]): ChainBlockView {
  return { hash, height, prevHash, records };
}

function rec(record: unknown, txid = "f".repeat(64)): ChainRecord {
  return { txid, record: record as Record<string, unknown> };
}

describe("syncOnce — order-book projection from the chain", () => {
  it("opens an order, is idempotent across runs, and advances the cursor", async () => {
    const src = chain([GENESIS, block("h1", 1, "h0", [rec(orderRec())])]);
    const store = new MemSettlementStore();
    const cursors = new MemCursorStore();

    const r1 = await syncOnce(src, store, cursors);
    expect(r1).toMatchObject({ ordersOpened: 1, scannedBlocks: 2, skipped: 0 });
    expect(r1.cursor).toEqual({ hash: "h1", height: 1 });
    const order = await store.getOrder("ord-0123456789abcdef");
    expect(order).toMatchObject({ status: "ACTIVE", sellerDid, txid: "f".repeat(64) });

    const r2 = await syncOnce(src, store, cursors);
    expect(r2).toMatchObject({ ordersOpened: 0, scannedBlocks: 0, cursor: { hash: "h1", height: 1 } });
    expect((await store.listOrders()).length).toBe(1);
  });

  it("applies a seller cancel and reports a match-after-cancel conflict", async () => {
    const src = chain([
      GENESIS,
      block("h1", 1, "h0", [rec(orderRec())]),
      block("h2", 2, "h1", [rec(orderRec({ status: "CANCELLED", orderSeq: 1, giveToken: undefined, giveAmount: undefined, giveChain: undefined, wantCurrency: undefined, wantAmount: undefined, wantRail: undefined, validUntil: undefined } as Partial<P2pOrderRecordInput>))]),
      block("h3", 3, "h2", [rec(swapRec())]),
    ]);
    const store = new MemSettlementStore();
    const r = await syncOnce(src, store, new MemCursorStore());
    expect(r.ordersOpened).toBe(1);
    expect(r.ordersCancelled).toBe(1);
    expect(r.swapsAppended).toBe(1);
    expect(r.conflicts.some((c) => c.includes("already cancelled"))).toBe(true);
    expect((await store.getOrder("ord-0123456789abcdef"))?.status).toBe("CANCELLED");
    const events = await store.events("swap-0123456789abcdef");
    expect(events.map((e) => e.status)).toEqual(["MATCHED"]);
  });

  it("claims the order MATCHED from an engine swap event", async () => {
    const src = chain([GENESIS, block("h1", 1, "h0", [rec(orderRec()), rec(swapRec())])]);
    const store = new MemSettlementStore();
    const r = await syncOnce(src, store, new MemCursorStore());
    expect(r.ordersOpened).toBe(1);
    expect(r.swapsAppended).toBe(1);
    expect(r.conflicts).toEqual([]);
    const order = await store.getOrder("ord-0123456789abcdef");
    expect(order).toMatchObject({ status: "MATCHED", swapId: "swap-0123456789abcdef" });
  });

  it("skips records with a bad signature or unknown type", async () => {
    const forged = { ...orderRec(), sig: "00".repeat(64) };
    const src = chain([
      GENESIS,
      block("h1", 1, "h0", [rec(forged), rec({ type: "social.donation", from: sellerDid, to: "x", ts: Date.now() })]),
    ]);
    const store = new MemSettlementStore();
    const r = await syncOnce(src, store, new MemCursorStore());
    expect(r.skipped).toBe(2);
    expect(await store.getOrder("ord-0123456789abcdef")).toBeNull();
    expect(r.cursor).toEqual({ hash: "h1", height: 1 });
  });

  it("fails closed on an unservable head without moving the cursor", async () => {
    const src: SocialSource = {
      async head() {
        return { hash: "missing" };
      },
      async blockByHash() {
        return null;
      },
    };
    const store = new MemSettlementStore();
    const cursors = new MemCursorStore();
    await cursors.set({ hash: "h1", height: 1 });
    const r = await syncOnce(src, store, cursors);
    expect(r.error).toMatch(/unservable/);
    expect(await cursors.get()).toEqual({ hash: "h1", height: 1 });
  });

  it("applies nothing when the walk is truncated on a fresh store", async () => {
    const src = chain([GENESIS, block("h1", 1, "h0", [rec(orderRec())])]);
    const store = new MemSettlementStore();
    const cursors = new MemCursorStore();
    const r = await syncOnce(src, store, cursors, { maxWalk: 1 });
    expect(r.error).toMatch(/truncated/);
    expect(await store.getOrder("ord-0123456789abcdef")).toBeNull();
    expect(await cursors.get()).toBeNull();
  });

  it("replays from genesis after a cursor that the chain no longer serves", async () => {
    const src = chain([GENESIS, block("h1b", 1, "h0", [rec(orderRec())])]);
    const store = new MemSettlementStore();
    const cursors = new MemCursorStore();
    await cursors.set({ hash: "pruned", height: 9 });
    const r = await syncOnce(src, store, cursors);
    expect(r.error).toBeUndefined();
    expect(r.ordersOpened).toBe(1);
    expect(await cursors.get()).toEqual({ hash: "h1b", height: 1 });
  });
});

describe("replayVerify (docs/p2p.md §14 drift check)", () => {
  it("reports chain rows the store lost and store-only rows the chain lacks", async () => {
    const src = chain([GENESIS, block("h1", 1, "h0", [rec(orderRec())])]);
    const store = new MemSettlementStore();
    // chain has ord-0123456789abcdef; store only has a legacy engine order
    await store.createOrder({
      orderId: "ord-aaaaaaaaaaaaaaaa",
      type: "limit_sell",
      sellerDid: "did:key:zLEGACY",
      giveToken: "USDT",
      giveAmount: "1",
      giveChain: "L0",
      wantCurrency: "USD",
      wantAmount: "1",
      wantRail: "wechat",
      validUntil: Math.floor(Date.now() / 1000) + 3600,
      status: "ACTIVE",
      signature: "sig",
      createdAt: Date.now(),
    });
    const report = await replayVerify(src, store);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["order ord-0123456789abcdef (chain ACTIVE)"]);
    expect(report.extra).toEqual(["order ord-aaaaaaaaaaaaaaaa (store-only, not on chain)"]);
    expect(report.scanned).toBe(2);
  });

  it("is ok when the store mirrors the chain", async () => {
    const src = chain([GENESIS, block("h1", 1, "h0", [rec(orderRec())])]);
    const store = new MemSettlementStore();
    await syncOnce(src, store, new MemCursorStore());
    const report = await replayVerify(src, store);
    expect(report).toMatchObject({ ok: true, missing: [], extra: [] });
  });
});
