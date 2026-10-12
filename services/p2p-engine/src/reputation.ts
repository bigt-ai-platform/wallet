/**
 * Derived reputation for P2P sellers and buyers (docs/p2p.md §25).
 *
 * Everything here is computed from the append-only swap event log — the same
 * history the `social.p2p-swap` anchor makes verifiable — and nothing is
 * stored or anchored: reputation is a projection of facts both parties already
 * signed, never a new source of truth. It is role-aware (a DID has separate
 * seller and buyer profiles), PII-free (counts, rates, latencies and public
 * DIDs only), and wash-resistant: at most `pairCap` swaps per counterparty
 * pair count toward the aggregates, so two colluding DIDs cannot inflate each
 * other with unlimited trades (docs/p2p.md §12 "both parties collude").
 *
 * Counted set: terminal swaps only (COMPLETED / EXPIRED / ESCROW_REFUNDED /
 * CANCELLED), pair-capped and ordered by match time. `completionRate` is
 * completed / (completed + expired + refunded) — cancellations are neutral
 * (either party may cancel before payment) and reported separately.
 */
import type { P2pSwapEvent } from "./types.js";

export type ReputationTier = "new" | "established" | "trusted";

/** One unit of traded volume, summed as a decimal string. */
export interface VolumeAmount {
  /** Currency (want side, e.g. "USD"/"CNY") or token symbol (give side). */
  unit: string;
  amount: string;
}

/** Role-aware reputation summary — public, PII-free. */
export interface RoleReputation {
  /** Terminal swaps counted toward the aggregates (pair-capped). */
  trades: number;
  /** All terminal swaps, before the pair cap. */
  rawTrades: number;
  /** Swaps still in flight (not counted). */
  openSwaps: number;
  completed: number;
  cancelled: number;
  /** Terminal EXPIRED — for a buyer this is the no-show counter. */
  expired: number;
  refunded: number;
  /** Swaps where a dispute was opened. */
  disputes: number;
  /** Arbitration decided against this role. */
  lostDisputes: number;
  /** Completed volume (pair-capped), want + give units. */
  volume: VolumeAmount[];
  /** Mean match → payment claim, ms (buyer-side). */
  avgPayMs: number | null;
  /** Mean payment claim → seller confirm, ms (seller-side). */
  avgConfirmMs: number | null;
  /** Mean seller confirm → release, ms (seller-side). */
  avgReleaseMs: number | null;
  /** First swap activity, unix ms (account age). */
  since: number | null;
  /** Distinct counterparties, uncapped. */
  counterparties: number;
  /** completed / (completed + expired + refunded); cancellations neutral. */
  completionRate: number;
  tier: ReputationTier;
}

export interface ReputationReport {
  did: string;
  seller: RoleReputation;
  buyer: RoleReputation;
}

/** One swap's contribution — the admin-only detail view. */
export interface SwapAttribution {
  swapId: string;
  role: "seller" | "buyer";
  counterparty: string;
  status: string;
  at: number;
  counted: boolean;
  completed: boolean;
  expired: boolean;
  cancelled: boolean;
  refunded: boolean;
  disputed: boolean;
  lostDispute: boolean;
  payMs: number | null;
  confirmMs: number | null;
  releaseMs: number | null;
}

export interface ReputationDetail extends ReputationReport {
  swaps: SwapAttribution[];
}

/** Tier thresholds (docs/p2p.md §25). */
const TRUSTED_TRADES = 10;
const TRUSTED_COMPLETION = 0.95;
const ESTABLISHED_TRADES = 3;
const ESTABLISHED_COMPLETION = 0.8;

const TERMINAL = new Set(["COMPLETED", "EXPIRED", "ESCROW_REFUNDED", "CANCELLED"]);

function emptyRole(): RoleReputation {
  return {
    trades: 0,
    rawTrades: 0,
    openSwaps: 0,
    completed: 0,
    cancelled: 0,
    expired: 0,
    refunded: 0,
    disputes: 0,
    lostDisputes: 0,
    volume: [],
    avgPayMs: null,
    avgConfirmMs: null,
    avgReleaseMs: null,
    since: null,
    counterparties: 0,
    completionRate: 0,
    tier: "new",
  };
}

function eventAt(list: readonly P2pSwapEvent[], type: string): number | null {
  const e = list.find((x) => x.eventType === type);
  return e ? e.at : null;
}

function mean(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function completionRate(r: RoleReputation): number {
  const decided = r.completed + r.expired + r.refunded;
  return decided ? r.completed / decided : 0;
}

function tierOf(r: RoleReputation): ReputationTier {
  const rate = completionRate(r);
  if (r.trades >= TRUSTED_TRADES && rate >= TRUSTED_COMPLETION && r.lostDisputes === 0) return "trusted";
  if (r.trades >= ESTABLISHED_TRADES && rate >= ESTABLISHED_COMPLETION) return "established";
  return "new";
}

/** Swap timeline → both parties' attribution rows. */
export function attributeSwap(list: readonly P2pSwapEvent[], counted: boolean): SwapAttribution[] {
  const sorted = [...list].sort((a, b) => a.seq - b.seq);
  const latest = sorted[sorted.length - 1];
  const disputed = sorted.some((e) => e.dispute != null);
  const lostForSeller = latest.disputeOutcome === "release"; // seller refused; arbitration released to buyer
  const lostForBuyer = latest.disputeOutcome === "refund"; // arbitration refunded the seller
  const matchAt = eventAt(sorted, "match");
  const proofAt = eventAt(sorted, "payment_proof");
  const confirmAt = eventAt(sorted, "payment_confirm");
  const releaseAt = eventAt(sorted, "release");
  const payMs = matchAt !== null && proofAt !== null ? Math.max(0, proofAt - matchAt) : null;
  const confirmMs = proofAt !== null && confirmAt !== null ? Math.max(0, confirmAt - proofAt) : null;
  const releaseMs = confirmAt !== null && releaseAt !== null ? Math.max(0, releaseAt - confirmAt) : null;

  return (["seller", "buyer"] as const).map((role) => ({
    swapId: latest.swapId,
    role,
    counterparty: role === "seller" ? latest.buyerDid ?? "" : latest.sellerDid ?? "",
    status: latest.status,
    at: latest.at,
    counted: counted && TERMINAL.has(latest.status),
    completed: latest.status === "COMPLETED",
    expired: latest.status === "EXPIRED",
    cancelled: latest.status === "CANCELLED",
    refunded: latest.status === "ESCROW_REFUNDED",
    disputed,
    lostDispute: role === "seller" ? lostForSeller : lostForBuyer,
    payMs: role === "buyer" ? payMs : null,
    confirmMs: role === "seller" ? confirmMs : null,
    releaseMs: role === "seller" ? releaseMs : null,
  }));
}

interface SwapRow {
  list: P2pSwapEvent[];
  latest: P2pSwapEvent;
  matchAt: number;
  counted: boolean;
}

/** Group the log per swap and decide which swaps count (pair-capped). */
function rowsFromEvents(events: readonly P2pSwapEvent[], pairCap: number): SwapRow[] {
  const bySwap = new Map<string, P2pSwapEvent[]>();
  for (const e of events) {
    const list = bySwap.get(e.swapId) ?? [];
    list.push(e);
    bySwap.set(e.swapId, list);
  }
  const rows: SwapRow[] = [...bySwap.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.seq - b.seq);
      return { list: sorted, latest: sorted[sorted.length - 1], matchAt: eventAt(sorted, "match") ?? sorted[0].at, counted: false };
    })
    .sort((a, b) => a.matchAt - b.matchAt);
  const pairSeen = new Map<string, number>();
  for (const row of rows) {
    const pair = `${row.latest.sellerDid ?? ""}|${row.latest.buyerDid ?? ""}`;
    const terminal = TERMINAL.has(row.latest.status);
    row.counted = terminal && (pairSeen.get(pair) ?? 0) < pairCap;
    if (terminal) pairSeen.set(pair, (pairSeen.get(pair) ?? 0) + 1);
  }
  return rows;
}

function attribution(row: SwapRow): SwapAttribution[] {
  return attributeSwap(row.list, row.counted);
}

/**
 * Derive per-DID reputation from the whole swap event log. `pairCap` (default
 * 3) bounds how many swaps per counterparty pair count toward the aggregates —
 * wash-resistant by construction. Pure: no I/O, no PII, deterministic.
 */
export function reputationFromEvents(
  events: readonly P2pSwapEvent[],
  opts: { pairCap?: number } = {},
): Map<string, ReputationReport> {
  const rows = rowsFromEvents(events, Math.max(1, opts.pairCap ?? 3));
  const out = new Map<string, ReputationReport>();
  const report = (did: string): ReputationReport => {
    let r = out.get(did);
    if (!r) {
      r = { did, seller: emptyRole(), buyer: emptyRole() };
      out.set(did, r);
    }
    return r;
  };

  const payMs = new Map<string, number[]>();
  const confirmMs = new Map<string, number[]>();
  const releaseMs = new Map<string, number[]>();
  const counterparties = new Map<string, Set<string>>();

  for (const row of rows) {
    for (const attr of attribution(row)) {
      const did = attr.role === "seller" ? row.latest.sellerDid : row.latest.buyerDid;
      if (!did) continue;
      const r = report(did)[attr.role];
      if (r.since === null || row.matchAt < r.since) r.since = row.matchAt;
      const other = attr.counterparty;
      if (other) {
        const key = `${did}|${attr.role}`;
        const set = counterparties.get(key) ?? new Set<string>();
        set.add(other);
        counterparties.set(key, set);
      }
      if (TERMINAL.has(attr.status)) r.rawTrades += 1;
      else r.openSwaps += 1;
      if (!attr.counted) continue;
      r.trades += 1;
      if (attr.completed) r.completed += 1;
      if (attr.expired) r.expired += 1;
      if (attr.cancelled) r.cancelled += 1;
      if (attr.refunded) r.refunded += 1;
      if (attr.disputed) r.disputes += 1;
      if (attr.lostDispute) r.lostDisputes += 1;
      if (attr.completed) {
        for (const [unit, amount] of [
          [row.latest.wantCurrency, row.latest.wantAmount],
          [row.latest.giveToken, row.latest.giveAmount],
        ] as const) {
          if (!unit || !amount || !Number.isFinite(Number(amount))) continue;
          const prev = r.volume.find((v) => v.unit === unit);
          const sum = (prev ? Number(prev.amount) : 0) + Number(amount);
          const next = { unit, amount: sum.toFixed(2) };
          if (prev) Object.assign(prev, next);
          else r.volume.push(next);
        }
      }
      const push = (m: Map<string, number[]>, v: number | null) => {
        if (v === null) return;
        const list = m.get(`${did}|${attr.role}`) ?? [];
        list.push(v);
        m.set(`${did}|${attr.role}`, list);
      };
      push(payMs, attr.payMs);
      push(confirmMs, attr.confirmMs);
      push(releaseMs, attr.releaseMs);
    }
  }

  for (const [key, set] of counterparties) {
    const [did, role] = key.split("|") as [string, "seller" | "buyer"];
    report(did)[role].counterparties = set.size;
  }
  for (const [key, list] of payMs) {
    const [did, role] = key.split("|") as [string, "seller" | "buyer"];
    report(did)[role].avgPayMs = mean(list);
  }
  for (const [key, list] of confirmMs) {
    const [did, role] = key.split("|") as [string, "seller" | "buyer"];
    report(did)[role].avgConfirmMs = mean(list);
  }
  for (const [key, list] of releaseMs) {
    const [did, role] = key.split("|") as [string, "seller" | "buyer"];
    report(did)[role].avgReleaseMs = mean(list);
  }
  for (const r of out.values()) {
    r.seller.completionRate = completionRate(r.seller);
    r.buyer.completionRate = completionRate(r.buyer);
    r.seller.tier = tierOf(r.seller);
    r.buyer.tier = tierOf(r.buyer);
  }
  return out;
}

/** Reputation of one DID — zeroed roles when it has no swap history. */
export function reputationForDid(did: string, map: ReadonlyMap<string, ReputationReport>): ReputationReport {
  return map.get(did) ?? { did, seller: emptyRole(), buyer: emptyRole() };
}

/** Per-swap attribution for one DID (admin-only detail). */
export function reputationDetail(
  events: readonly P2pSwapEvent[],
  did: string,
  opts: { pairCap?: number } = {},
): ReputationDetail {
  const rows = rowsFromEvents(events, Math.max(1, opts.pairCap ?? 3));
  const swaps = rows
    .filter((row) => row.latest.sellerDid === did || row.latest.buyerDid === did)
    .map((row) => {
      const role: "seller" | "buyer" = row.latest.sellerDid === did ? "seller" : "buyer";
      return attribution(row).find((a) => a.role === role)!;
    });
  return { ...reputationForDid(did, reputationFromEvents(events, opts)), swaps };
}
