/**
 * Derived reputation (docs/p2p.md §25): role-aware seller/buyer profiles
 * computed from the anchored swap event log — wash-resistant (pair-capped),
 * PII-free, and never a source of truth (no writes, nothing anchored).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  reputationDetail,
  reputationForDid,
  reputationFromEvents,
} from "../src/reputation.js";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import type { P2pOrder, P2pSwapEvent, P2pSwapStatus, SwapEventType } from "../src/types.js";

const S = "did:key:zSELLER";
const B = "did:key:zBUYER";
const B2 = "did:key:zBUYER2";

function ev(
  swapId: string,
  seq: number,
  status: P2pSwapStatus,
  eventType: SwapEventType,
  at: number,
  extra: Partial<P2pSwapEvent> = {},
): P2pSwapEvent {
  return {
    swapId,
    seq,
    status,
    eventType,
    at,
    sellerDid: S,
    buyerDid: B,
    giveToken: "USDT",
    giveAmount: "100",
    wantCurrency: "USD",
    wantAmount: "101",
    ...extra,
  };
}

/** match → lock → proof → confirm → release → complete (a clean trade). */
function completedLog(swapId: string, t0: number, extra: Partial<P2pSwapEvent> = {}): P2pSwapEvent[] {
  return [
    ev(swapId, 0, "MATCHED", "match", t0, extra),
    ev(swapId, 1, "ESCROW_LOCKED", "escrow_lock", t0 + 1000, extra),
    ev(swapId, 2, "PAYMENT_CLAIMED", "payment_proof", t0 + 5000, extra),
    ev(swapId, 3, "PAYMENT_VERIFIED", "payment_confirm", t0 + 9000, extra),
    ev(swapId, 4, "ESCROW_RELEASED", "release", t0 + 11000, extra),
    ev(swapId, 5, "COMPLETED", "complete", t0 + 12000, extra),
  ];
}

function buyerLog(swapId: string, status: P2pSwapStatus, eventType: SwapEventType, t0: number, extra: Partial<P2pSwapEvent> = {}): P2pSwapEvent[] {
  return [
    ev(swapId, 0, "MATCHED", "match", t0, extra),
    ev(swapId, 1, "ESCROW_LOCKED", "escrow_lock", t0 + 1000, extra),
    ev(swapId, 2, status, eventType, t0 + 2000, extra),
  ];
}

describe("reputationFromEvents — outcome attribution", () => {
  it("credits a completed trade to both roles with volume and latencies", () => {
    const map = reputationFromEvents(completedLog("swap-0000000000000001", 1_700_000_000_000));
    const seller = map.get(S)!.seller;
    const buyer = map.get(B)!.buyer;

    expect(seller.trades).toBe(1);
    expect(seller.completed).toBe(1);
    expect(seller.completionRate).toBe(1);
    expect(seller.volume).toEqual([
      { unit: "USD", amount: "101.00" },
      { unit: "USDT", amount: "100.00" },
    ]);
    // proof−match = 5000, confirm−proof = 4000, release−confirm = 2000
    expect(buyer.avgPayMs).toBe(5000);
    expect(seller.avgConfirmMs).toBe(4000);
    expect(seller.avgReleaseMs).toBe(2000);
    expect(seller.counterparties).toBe(1);
    expect(seller.since).toBe(1_700_000_000_000);
  });

  it("counts an expired swap against the buyer's no-show record", () => {
    const log = buyerLog("swap-0000000000000002", "EXPIRED", "expire", 1_700_000_000_000);
    const map = reputationFromEvents(log);
    expect(map.get(B)!.buyer.expired).toBe(1);
    expect(map.get(S)!.seller.expired).toBe(1);
    expect(map.get(B)!.buyer.completed).toBe(0);
    expect(map.get(B)!.buyer.completionRate).toBe(0);
  });

  it("treats cancellations as neutral for the completion rate", () => {
    const log = [
      ...buyerLog("swap-0000000000000003", "CANCELLED", "cancel", 1_700_000_000_000),
      ...completedLog("swap-0000000000000004", 1_700_000_100_000),
    ];
    const map = reputationFromEvents(log);
    const seller = map.get(S)!.seller;
    expect(seller.cancelled).toBe(1);
    expect(seller.completed).toBe(1);
    expect(seller.completionRate).toBe(1); // 1 / (1 completed + 0 expired + 0 refunded)
  });

  it("attributes arbitration outcomes to the losing role", () => {
    const refundLost = buyerLog("swap-0000000000000005", "ESCROW_REFUNDED", "refund", 1_700_000_000_000, {
      dispute: "RESOLVED",
      disputeOutcome: "refund",
    });
    const releaseLost = completedLog("swap-0000000000000006", 1_700_000_100_000, {
      dispute: "RESOLVED",
      disputeOutcome: "release",
    });
    const map = reputationFromEvents([...refundLost, ...releaseLost]);

    expect(map.get(B)!.buyer.lostDisputes).toBe(1); // refund → seller wins
    expect(map.get(B)!.buyer.disputes).toBe(2);
    expect(map.get(S)!.seller.lostDisputes).toBe(1); // release → buyer wins
    expect(map.get(S)!.seller.refunded).toBe(1);
  });

  it("tracks in-flight swaps without counting them", () => {
    const log = buyerLog("swap-0000000000000008", "PAYMENT_CLAIMED", "payment_proof", 1_700_000_000_000);
    const map = reputationFromEvents(log);
    expect(map.get(S)!.seller.openSwaps).toBe(1);
    expect(map.get(S)!.seller.trades).toBe(0);
  });
});

describe("reputationFromEvents — wash resistance and tiers", () => {
  it("caps counted swaps per counterparty pair but reports raw totals", () => {
    const log = [1, 2, 3, 4, 5].flatMap((i) =>
      completedLog(`swap-${String(i).padStart(16, "0")}`, 1_700_000_000_000 + i * 60_000),
    );
    const seller = reputationFromEvents(log).get(S)!.seller;
    expect(seller.trades).toBe(3); // pairCap = 3
    expect(seller.rawTrades).toBe(5);
    expect(seller.volume.find((v) => v.unit === "USD")?.amount).toBe("303.00"); // 3 × 101
    expect(seller.counterparties).toBe(1);
  });

  it("counts unlimited swaps across distinct counterparties", () => {
    const log = [
      ...completedLog("swap-0000000000000001", 1_700_000_000_000),
      ...completedLog("swap-0000000000000002", 1_700_000_100_000).map((e) => ({ ...e, buyerDid: B2 })),
    ];
    const seller = reputationFromEvents(log).get(S)!.seller;
    expect(seller.trades).toBe(2);
    expect(seller.counterparties).toBe(2);
  });

  it("derives tiers from counted trades, completion and disputes", () => {
    const trusted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) =>
      completedLog(`swap-${String(i).padStart(16, "0")}`, 1_700_000_000_000 + i * 60_000),
    );
    // Distinct buyers so the pair cap does not bite; 12 clean completed trades.
    const clean = trusted.flatMap((log, i) => log.map((e) => ({ ...e, buyerDid: `did:key:zB${i}` })));
    expect(reputationFromEvents(clean).get(S)!.seller.tier).toBe("trusted");

    const three = clean.filter((e) => Number(e.swapId.slice(-2)) <= 3);
    expect(reputationFromEvents(three).get(S)!.seller.tier).toBe("established");

    const two = clean.filter((e) => Number(e.swapId.slice(-2)) <= 2);
    expect(reputationFromEvents(two).get(S)!.seller.tier).toBe("new");

    const disputed = clean.map((e, i) => (i === 5 ? { ...e, dispute: "RESOLVED", disputeOutcome: "release" as const } : e));
    expect(reputationFromEvents(disputed).get(S)!.seller.tier).toBe("established"); // a lost dispute blocks "trusted"
  });

  it("never leaks PII into the summary", () => {
    const log = completedLog("swap-0000000000000001", 1_700_000_000_000, {
      receiveAddress: "n1SECRET",
      remark: "REMARK-1",
      receiptSha256: "a".repeat(64),
    });
    const json = JSON.stringify([...reputationFromEvents(log).values()]);
    for (const secret of ["n1SECRET", "REMARK-1", "a".repeat(64)]) {
      expect(json).not.toContain(secret);
    }
  });

  it("returns zeroed roles for unknown dids", () => {
    const r = reputationForDid("did:key:zNOBODY", reputationFromEvents([]));
    expect(r.seller.trades).toBe(0);
    expect(r.seller.tier).toBe("new");
    expect(r.buyer.tier).toBe("new");
  });
});

describe("reputationDetail", () => {
  it("returns only the did's own role rows, respecting the pair cap", () => {
    const log = [1, 2, 3, 4].flatMap((i) =>
      completedLog(`swap-${String(i).padStart(16, "0")}`, 1_700_000_000_000 + i * 60_000),
    );
    const detail = reputationDetail(log, S);
    expect(detail.swaps).toHaveLength(4);
    expect(detail.swaps.every((s) => s.role === "seller" && s.counterparty === B)).toBe(true);
    expect(detail.swaps.filter((s) => s.counted)).toHaveLength(3);
    expect(detail.seller.trades).toBe(3);
  });
});

describe("reputation routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const store = new MemSettlementStore();

  beforeEach(async () => {
    store.swapEvents.clear();
    store.orders.clear();
    for (const e of completedLog("swap-0000000000000001", 1_700_000_000_000)) await store.appendEvent(e);
    app = await buildApp({
      store,
      env: { SETTLEMENT_ADMIN_TOKEN: "adm" } as NodeJS.ProcessEnv,
      chain: null,
    });
  });

  it("GET /public/reputation/:did serves the public summary", async () => {
    const r = await app.inject({ method: "GET", url: `/public/reputation/${encodeURIComponent(S)}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.did).toBe(S);
    expect(body.seller).toMatchObject({ trades: 1, completed: 1, completionRate: 1, tier: "new" });
    expect(body.buyer).toMatchObject({ trades: 0 }); // S is never a buyer in the fixture
    const b = await app.inject({ method: "GET", url: `/public/reputation/${encodeURIComponent(B)}` });
    expect(b.json().buyer).toMatchObject({ trades: 1, completed: 1, avgPayMs: 5000 });
  });

  it("zero-fills unknown dids and rejects oversized ones", async () => {
    const ok = await app.inject({ method: "GET", url: "/public/reputation/did:key:zNOBODY" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().seller.trades).toBe(0);
    const bad = await app.inject({ method: "GET", url: `/public/reputation/${"x".repeat(600)}` });
    expect([400, 414]).toContain(bad.statusCode); // fastify rejects over-long URLs before the guard
  });

  it("embeds compact seller stats in the public order book", async () => {
    await store.createOrder({
      orderId: "ord-0123456789abcdef",
      type: "limit_sell",
      sellerDid: S,
      giveToken: "USDT",
      giveAmount: "100",
      giveChain: "L0",
      wantCurrency: "USD",
      wantAmount: "101",
      wantRail: "bank",
      validUntil: 4_000_000_000,
      status: "ACTIVE",
      signature: "sig",
      createdAt: 1_700_000_000_000,
    } as P2pOrder);
    const r = await app.inject({ method: "GET", url: "/public/orders" });
    expect(r.statusCode).toBe(200);
    expect(r.json().orders[0]).toMatchObject({
      sellerReputation: { trades: 1, completionRate: 1, tier: "new" },
    });
    expect(r.json().orders[0].signature).toBeUndefined();
  });

  it("keeps the per-swap attribution admin-only", async () => {
    const denied = await app.inject({ method: "GET", url: `/admin/reputation/${encodeURIComponent(S)}` });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: "GET",
      url: `/admin/reputation/${encodeURIComponent(S)}`,
      headers: { "x-settlement-admin-token": "adm" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().swaps).toHaveLength(1);
    expect(ok.json().swaps[0]).toMatchObject({ role: "seller", counted: true, completed: true });
  });
});
