#!/usr/bin/env node
/**
 * prod-soak.mjs — long-running stability + performance probe for the DEPLOYED
 * wallet stack (no local infra).
 *
 * Default workload is READ-ONLY: the public P2P book, engine health/capabilities,
 * signed party-scoped reads with an ephemeral DID, L0/L1 chain tips, the L0
 * bridge-info preflight, and the L1-order market reads. Writes are opt-in.
 *
 * Quick smoke (run by `e2e/e2etest.sh p2p-prod-soak`, gated):
 *   node e2e/prod-soak.mjs --duration 30 --target p2p
 *
 * A real long run (hours/days):
 *   node e2e/prod-soak.mjs --duration 86400 --concurrency 4 --target all
 *   node e2e/prod-soak.mjs --duration 0 --target all      # until Ctrl-C
 *
 * Useful env/args:
 *   --target p2p|chain|order|all            default all
 *   --duration SEC                          default 300; 0 = until signal
 *   --concurrency N                         default 2
 *   --interval MS                           default 1000
 *   --out FILE                              default e2e/test-results/prod-soak-<ts>.json
 *   --write                                 opt-in create/cancel a no-funds bid every 5m
 *   --no-signed                             skip the signed /swaps/mine probe
 *   --require-market                        fail if Nvidia/USDT are absent on L1-order
 *   E2E_PROD_L0_URL / _L1_SOCIAL_URL / _L1_ORDER_URL / _P2P_URL
 *   E2E_PROD_SOAK_KEY=<hex seed>            stable DID for signed reads/writes
 *   E2E_PROD_SOAK_MAX_ERROR_RATE=0.02
 *   E2E_PROD_SOAK_P95_MS=2500
 *   E2E_PROD_SOAK_P99_MS=8000
 *   E2E_PROD_SOAK_WATCH_STALL_SEC=300
 *   E2E_PROD_SOAK_JSONL=1                   append raw samples (large)
 *
 * Exit 1 if the error-rate/latency budget or a stability check fails; the JSON
 * report carries every per-endpoint percentile and the periodic chain snapshots.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : fallback;
}
function flag(name, fallback = false) {
  if (argv.includes(`--${name}`)) return true;
  if (argv.includes(`--no-${name}`)) return false;
  const v = process.env[`E2E_PROD_SOAK_${name.toUpperCase().replace(/-/g, "_")}`];
  return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
}
function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function trim(url) {
  return String(url || "").replace(/\/+$/, "");
}
function nowMs() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const target = String(arg("target", process.env.E2E_PROD_SOAK_TARGET || "all")).toLowerCase();
const durationSec = num(
  arg("duration", process.env.E2E_PROD_SOAK_SECONDS ?? "300"),
  300,
  0,
);
const concurrency = num(
  arg("concurrency", process.env.E2E_PROD_SOAK_CONCURRENCY ?? "2"),
  2,
  1,
  32,
);
const intervalMs = num(
  arg("interval", process.env.E2E_PROD_SOAK_INTERVAL_MS ?? "1000"),
  1000,
  50,
);
const timeoutMs = num(
  arg("timeout", process.env.E2E_PROD_SOAK_TIMEOUT_MS ?? "12000"),
  12000,
  500,
);
const warmupSec = num(
  arg("warmup", process.env.E2E_PROD_SOAK_WARMUP_SEC ?? "15"),
  15,
  0,
);
const maxErrorRate = num(
  arg("max-error-rate", process.env.E2E_PROD_SOAK_MAX_ERROR_RATE ?? "0.02"),
  0.02,
  0,
  1,
);
const p95Limit = num(
  arg("p95", process.env.E2E_PROD_SOAK_P95_MS ?? "2500"),
  2500,
  1,
);
const p99Limit = num(
  arg("p99", process.env.E2E_PROD_SOAK_P99_MS ?? "8000"),
  8000,
  1,
);
const stabilityMs = num(
  arg("stability-ms", process.env.E2E_PROD_SOAK_STABILITY_MS ?? "60000"),
  60_000,
  5_000,
);
const watchStallSec = num(
  arg("watch-stall-sec", process.env.E2E_PROD_SOAK_WATCH_STALL_SEC ?? "300"),
  300,
  30,
);
const write = flag("write") || process.env.E2E_PROD_SOAK_WRITE === "1";
const signed = !argv.includes("--no-signed") && process.env.E2E_PROD_SOAK_SIGNED !== "0";
const requireMarket = flag("require-market") || process.env.E2E_PROD_SOAK_REQUIRE_MARKET === "1";
const jsonl = flag("jsonl") || process.env.E2E_PROD_SOAK_JSONL === "1";
const label = String(arg("label", process.env.E2E_PROD_SOAK_LABEL || "prod-soak"));
const outFile = path.resolve(
  arg(
    "out",
    process.env.E2E_PROD_SOAK_OUT ||
      path.join(ROOT, "e2e", "test-results", `prod-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  ),
);
const jsonlFile = outFile.replace(/\.json$/i, ".jsonl");

const urls = {
  L0: trim(process.env.E2E_PROD_L0_URL || "https://eu1.bigtangle.org"),
  SOCIAL: trim(process.env.E2E_PROD_L1_SOCIAL_URL || "https://socialeu1.bigtangle.org"),
  ORDER: trim(process.env.E2E_PROD_L1_ORDER_URL || "https://ordereu1.bigtangle.org"),
  P2P: trim(process.env.E2E_PROD_P2P_URL || "https://eu.wallet.bigt.ai/p2p"),
  WALLET: trim(process.env.E2E_PROD_WALLET_URL || "https://wallet.bigt.ai"),
};

const includeP2P = target === "p2p" || target === "all";
const includeChain = target === "chain" || target === "all";
const includeOrder = target === "order" || target === "all";
if (!includeP2P && !includeChain && !includeOrder) {
  console.error(`unknown --target '${target}' (use p2p|chain|order|all)`);
  process.exit(2);
}

const startedAt = nowMs();
const warmupUntil = startedAt + warmupSec * 1000;
const deadline = durationSec > 0 ? startedAt + durationSec * 1000 : 0;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.error("\n[soak] SIGINT — draining in-flight requests and writing the report…");
});
process.on("SIGTERM", () => {
  stopping = true;
});

/** name → { count, errors, samples: [{ms, ok, at}] } */
const stats = new Map();
function endpointStats(name) {
  let s = stats.get(name);
  if (!s) {
    s = { count: 0, errors: 0, samples: [], statuses: {} };
    stats.set(name, s);
  }
  return s;
}
let rawJsonl = null;
if (jsonl) {
  fs.mkdirSync(path.dirname(jsonlFile), { recursive: true });
  rawJsonl = fs.createWriteStream(jsonlFile, { flags: "a" });
}
function record(name, ms, ok, status, error) {
  const s = endpointStats(name);
  s.count++;
  if (!ok) s.errors++;
  s.statuses[status] = (s.statuses[status] || 0) + 1;
  if (s.samples.length < 250_000) s.samples.push({ ms, ok, at: nowMs() });
  if (rawJsonl) rawJsonl.write(JSON.stringify({ at: nowMs(), name, ms, ok, status, error }) + "\n");
}

const headers = {
  "user-agent": "wallet-prod-soak/1.0 (+https://wallet.bigt.ai)",
  accept: "application/json, text/plain, */*",
};

async function http(name, url, opts = {}) {
  const t0 = performance.now();
  let status = 0;
  let ok = false;
  let error;
  let text = "";
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: { ...headers, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
    ok = res.ok;
    if (ok && opts.validate) {
      const v = opts.validate(text);
      if (v && v.ok === false) {
        ok = false;
        error = `validate: ${v.error}`;
      }
    }
    if (!ok && !error) error = `HTTP ${status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = performance.now() - t0;
  record(name, ms, ok, status, error);
  return { ok, status, text, ms, error };
}

function jsonOk(expected) {
  return (text) => {
    try {
      const j = JSON.parse(text);
      if (expected && !expected(j)) return { ok: false, error: "unexpected JSON shape" };
      return { ok: true };
    } catch {
      return { ok: false, error: "non-JSON response" };
    }
  };
}

/** Parse the nested {text:"{...json...}"} chain reply. */
function chainTips(text) {
  try {
    const outer = JSON.parse(text);
    const inner = typeof outer.text === "string" ? JSON.parse(outer.text) : outer;
    return {
      height: typeof inner.height === "number" ? inner.height : null,
      hash: inner.prevBlockHash || inner.hash || null,
    };
  } catch {
    return { height: null, hash: null };
  }
}

let pq = null;
let did = null;
let signPQ = null;
let canonicalJson = null;
async function initIdentity() {
  if (!signed && !write) return;
  try {
    const { PQKey } = await import("../packages/bigtangle-ts/dist/index.js");
    const pqmod = await import("../packages/did/dist/pq.js");
    const signmod = await import("../services/p2p-engine/dist/sign.js");
    const seed = process.env.E2E_PROD_SOAK_KEY?.trim();
    pq = seed ? PQKey.fromPrivateKeyHex(seed) : PQKey.createNew();
    did = pqmod.didFromPQKey(pq);
    signPQ = pqmod.signChallengePQ;
    canonicalJson = signmod.canonicalJson;
  } catch (e) {
    console.error(`[soak] signed probes disabled (build dist first): ${e instanceof Error ? e.message : e}`);
  }
}
function signedBody(fields, requestPath) {
  const payload = {
    ...fields,
    did,
    nonce: randomBytes(16).toString("hex"),
    timestamp: nowMs(),
    requestMethod: "POST",
    requestPath,
  };
  const digest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ...payload, signature: signPQ(pq, digest) };
}

const endpoints = [];
let runPool = [];
function add(name, url, opts, weight = 1) {
  endpoints.push({ name, url, opts, weight });
}

if (includeP2P) {
  add("GET /p2p/healthz", `${urls.P2P}/healthz`, {}, 2);
  add(
    "GET /p2p/capabilities",
    `${urls.P2P}/capabilities`,
    { validate: jsonOk((j) => j && typeof j === "object" && "chain" in j) },
    3,
  );
  add(
    "GET /p2p/public/orders ACTIVE",
    `${urls.P2P}/public/orders?status=ACTIVE`,
    { validate: jsonOk((j) => Array.isArray(j.orders)) },
    4,
  );
  add(
    "GET /p2p/public/orders MATCHED",
    `${urls.P2P}/public/orders?status=MATCHED`,
    { validate: jsonOk((j) => Array.isArray(j.orders)) },
    1,
  );
}

if (includeChain) {
  for (const [label, base] of [
    ["L0", urls.L0],
    ["L1-SOCIAL", urls.SOCIAL],
    ["L1-order", urls.ORDER],
  ]) {
    add(`POST ${label}/getTips`, `${base}/getTips`, {
      method: "POST",
      body: {},
      validate: (t) => (chainTips(t).height !== null ? { ok: true } : { ok: false, error: "no height" }),
    }, 2);
  }
  add("POST L0/getBridgeInfo", `${urls.L0}/getBridgeInfo`, {
    method: "POST",
    body: {},
    validate: jsonOk((j) => j && (typeof j === "object" || typeof j.text === "string")),
  });
}

if (includeOrder) {
  add("POST L1-order/searchExchangeTokens", `${urls.ORDER}/searchExchangeTokens`, {
    method: "POST",
    body: { keyword: "" },
    validate: jsonOk((j) => j && (Array.isArray(j.tokens) || Array.isArray(j))),
  }, 2);
  add("POST L1-order/getOrders", `${urls.ORDER}/getOrders`, {
    method: "POST",
    body: {},
    validate: jsonOk((j) => j && (Array.isArray(j.allOrdersSorted) || Array.isArray(j.orders) || Array.isArray(j))),
  }, 2);
  add("POST L1-order/getOrdersTicker", `${urls.ORDER}/getOrdersTicker`, {
    method: "POST",
    body: { count: 50 },
    validate: jsonOk((j) => j && (Array.isArray(j.tickers) || Array.isArray(j))),
  }, 1);
}

/** Optional signed read: exercises DID auth/nonce/rate limits without writes. */
function signedEndpoint() {
  if (!includeP2P || !signed || !pq) return;
  add("POST /p2p/swaps/mine (signed)", `${urls.P2P}/swaps/mine`, {
    method: "POST",
    dynamic: () => signedBody({}, "/swaps/mine"),
    validate: jsonOk((j) => Array.isArray(j.swaps)),
  }, 2);
}

/** Discover the Nvidia/USDT market for order-chain reads. */
const market = { nvidia: null, usdt: null, pairRead: false, error: null };
async function discoverMarket() {
  if (!includeOrder) return;
  const search = async (keyword) => {
    const r = await fetch(`${urls.ORDER}/searchExchangeTokens`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ keyword }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      const tokens = Array.isArray(j.tokens) ? j.tokens : Array.isArray(j) ? j : [];
      return tokens.find((t) =>
        [t.tokenname, t.tokensymbol, t.name].some(
          (v) => typeof v === "string" && v.trim().toLowerCase() === keyword.toLowerCase(),
        ),
      ) || null;
    } catch {
      return null;
    }
  };
  try {
    market.nvidia = await search("Nvidia");
    market.usdt = await search("USDT");
    if (market.nvidia && market.usdt) {
      const body = {
        tokenids: [market.nvidia.tokenid],
        basetoken: market.usdt.tokenid,
      };
      add(`POST L1-order/getOrders Nvidia/USDT`, `${urls.ORDER}/getOrders`, {
        method: "POST",
        body,
        validate: jsonOk((j) => j && (Array.isArray(j.allOrdersSorted) || Array.isArray(j.orders) || Array.isArray(j))),
      }, 3);
      add("POST L1-order/getOrdersTicker Nvidia/USDT", `${urls.ORDER}/getOrdersTicker`, {
        method: "POST",
        body: { tokenids: [market.nvidia.tokenid], basetoken: market.usdt.tokenid, count: 50 },
        validate: jsonOk((j) => j && (Array.isArray(j.tickers) || Array.isArray(j))),
      }, 2);
      market.pairRead = true;
    }
  } catch (e) {
    market.error = e instanceof Error ? e.message : String(e);
  }
}

/** Periodic stability probe: engine watcher + chain tips. Never counted as load. */
const snapshots = [];
let consecutiveWatchErrors = 0;
let maxWatchErrors = 0;
let chainResets = 0;
let probing = false;
const lastHeights = {};
async function stabilityProbe() {
  if (probing) return;
  probing = true;
  const snap = { at: nowMs() };
  if (includeP2P) {
    try {
      const caps = await fetch(`${urls.P2P}/capabilities`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (caps.ok) {
        const j = await caps.json();
        snap.watch = j.watch || null;
        snap.engine = { ok: true, chain: j.chain, rails: j.rails };
        if (snap.watch && snap.watch.lastError) consecutiveWatchErrors++;
        else consecutiveWatchErrors = 0;
      } else {
        snap.engine = { ok: false, status: caps.status };
        consecutiveWatchErrors++;
      }
    } catch (e) {
      snap.engine = { ok: false, error: e instanceof Error ? e.message : String(e) };
      consecutiveWatchErrors++;
    }
    maxWatchErrors = Math.max(maxWatchErrors, consecutiveWatchErrors);
    try {
      const book = await fetch(`${urls.P2P}/public/orders?status=ACTIVE`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await book.text();
      const j = JSON.parse(text);
      snap.book = {
        status: book.status,
        count: Array.isArray(j.orders) ? j.orders.length : -1,
        valid: Array.isArray(j.orders),
      };
    } catch (e) {
      snap.book = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (includeChain) {
    for (const [label, base] of [
      ["L0", urls.L0],
      ["L1-SOCIAL", urls.SOCIAL],
      ["L1-order", urls.ORDER],
    ]) {
      try {
        const r = await fetch(`${base}/getTips`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await r.text();
        const t = chainTips(text);
        snap[label] = { status: r.status, ...t };
        if (typeof t.height === "number") {
          if (typeof lastHeights[label] === "number" && t.height < lastHeights[label]) chainResets++;
          lastHeights[label] = t.height;
        }
      } catch (e) {
        snap[label] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  snapshots.push(snap);
  probing = false;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function buildReport() {
  const finishedAt = nowMs();
  const elapsedSec = Math.max(0.001, (finishedAt - startedAt) / 1000);
  const steady = (s) => s.samples.filter((x) => x.at >= warmupUntil);
  const endpointsReport = {};
  let total = 0;
  let errors = 0;
  const steadyLatencies = [];
  for (const [name, s] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const st = steady(s);
    total += s.count;
    errors += s.errors;
    const lat = st.map((x) => x.ms);
    steadyLatencies.push(...lat);
    endpointsReport[name] = {
      count: s.count,
      errors: s.errors,
      errorRate: s.count ? s.errors / s.count : 0,
      statuses: s.statuses,
      p50: round(percentile(lat, 50)),
      p95: round(percentile(lat, 95)),
      p99: round(percentile(lat, 99)),
      max: round(lat.length ? Math.max(...lat) : 0),
      mean: round(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0),
      samples: st.length,
    };
  }
  const p95 = percentile(steadyLatencies, 95);
  const p99 = percentile(steadyLatencies, 99);
  const errorRate = total ? errors / total : 0;
  const failures = [];
  if (errorRate > maxErrorRate) failures.push(`error rate ${(errorRate * 100).toFixed(2)}% > ${(maxErrorRate * 100).toFixed(2)}%`);
  if (p95 > p95Limit) failures.push(`steady p95 ${round(p95)}ms > ${p95Limit}ms`);
  if (p99 > p99Limit) failures.push(`steady p99 ${round(p99)}ms > ${p99Limit}ms`);
  if (maxWatchErrors >= 3) failures.push(`engine watcher lastError for ${maxWatchErrors} consecutive probes`);
  const last = snapshots[snapshots.length - 1];
  if (last?.watch?.lastError) failures.push(`engine watcher lastError at finish: ${last.watch.lastError}`);
  // Watch stall: social chain advanced but the engine watch height did not.
  if (includeChain && snapshots.length >= 2) {
    const first = snapshots[0];
    const socialFirst = first?.social ?? first?.["L1-SOCIAL"];
    const socialLast = last?.["L1-SOCIAL"];
    const watchFirst = first?.watch?.height;
    const watchLast = last?.watch?.height;
    if (
      socialFirst?.height != null &&
      socialLast?.height != null &&
      watchFirst != null &&
      watchLast != null &&
      socialLast.height > socialFirst.height + 1 &&
      watchLast <= watchFirst &&
      (finishedAt - startedAt) / 1000 > watchStallSec
    ) {
      failures.push(`engine watch height stalled at ${watchLast} while L1-SOCIAL advanced ${socialFirst.height}→${socialLast.height}`);
    }
  }
  if (requireMarket && includeOrder && !market.pairRead) {
    failures.push("Nvidia/USDT market not found on L1-order (set E2E_PROD_SOAK_REQUIRE_MARKET=0 to ignore)");
  }
  if (write && writes.failures) failures.push(`${writes.failures} write cycle(s) failed`);
  return {
    version: 1,
    label,
    target,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationSec: round(elapsedSec, 1),
    warmupSec,
    config: {
      concurrency,
      intervalMs,
      timeoutMs,
      warmupSec,
      maxErrorRate,
      p95Ms: p95Limit,
      p99Ms: p99Limit,
      stabilityMs,
      watchStallSec,
      write,
      signed,
      requireMarket,
      urls,
    },
    requests: total,
    errors,
    errorRate,
    throughputRps: round(total / elapsedSec, 3),
    steady: { requests: steadyLatencies.length, p50: round(percentile(steadyLatencies, 50)), p95: round(p95), p99: round(p99) },
    endpoints: endpointsReport,
    market,
    stability: {
      snapshots,
      chainResets,
      consecutiveWatchErrors,
      maxWatchErrors,
      finalWatch: last?.watch || null,
    },
    writes,
    thresholds: { maxErrorRate, p95Ms: p95Limit, p99Ms: p99Limit, watchStallSec },
    failures,
    passed: failures.length === 0,
  };
}
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Opt-in write cycle: create + cancel a no-funds buy bid (low impact). */
const writes = { cycles: 0, failures: 0, lastError: null, lastOrderId: null };
const RECEIVE = "1FvyAqqELFiQyaEWdhFbWF8MZapKPZS8J7";
async function writeCycle() {
  if (!write || !pq || !includeP2P) return;
  const orderId = `ord-${randomBytes(8).toString("hex")}`;
  writes.cycles++;
  const t0 = performance.now();
  let ok = false;
  let status = 0;
  let error;
  try {
    const create = await fetch(`${urls.P2P}/orders`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(
        signedBody(
          {
            type: "limit_buy",
            sellerDid: did,
            giveToken: "USDT",
            giveAmount: "1",
            giveChain: "L0",
            wantCurrency: "CNY",
            wantAmount: "7",
            wantRail: "wechat",
            validUntil: Math.floor(Date.now() / 1000) + 600,
            receiveAddress: RECEIVE,
            orderId,
          },
          "/orders",
        ),
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = create.status;
    const createText = await create.text();
    if (create.status !== 201 && create.status !== 200) throw new Error(`create ${create.status}: ${createText.slice(0, 200)}`);
    const id = JSON.parse(createText).orderId || orderId;
    writes.lastOrderId = id;
    const cancel = await fetch(`${urls.P2P}/orders/${id}/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(signedBody({ sellerDid: did }, `/orders/${id}/cancel`)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = cancel.status;
    const cancelText = await cancel.text();
    if (cancel.status !== 200) throw new Error(`cancel ${cancel.status}: ${cancelText.slice(0, 200)}`);
    ok = true;
    writes.lastError = null;
  } catch (e) {
    writes.failures++;
    error = e instanceof Error ? e.message : String(e);
    writes.lastError = error;
  }
  record("POST /p2p/orders write cycle", performance.now() - t0, ok, status, error);
}

async function worker(id) {
  while (!stopping && (deadline === 0 || nowMs() < deadline)) {
    const pool = runPool;
    if (!pool.length) {
      await sleep(intervalMs);
      continue;
    }
    const ep = pool[Math.floor(Math.random() * pool.length)];
    const body = typeof ep.opts.dynamic === "function" ? ep.opts.dynamic() : ep.opts.body;
    await http(ep.name, ep.url, { ...ep.opts, body });
    await sleep(intervalMs + Math.floor(Math.random() * Math.max(1, intervalMs / 2)));
  }
}

async function main() {
  await initIdentity();
  await discoverMarket();
  signedEndpoint();
  if (write && !pq) console.error("[soak] --write requested but identity init failed; writes disabled");
  if (!endpoints.length) {
    console.error("[soak] no endpoints for target", target);
    process.exit(2);
  }
  runPool = endpoints.flatMap((ep) => Array.from({ length: Math.max(1, ep.weight || 1) }, () => ep));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`[soak] ${label} target=${target} ${durationSec === 0 ? "until signal" : `${durationSec}s`} concurrency=${concurrency} interval=${intervalMs}ms`);
  console.log(`[soak] L0=${urls.L0} SOCIAL=${urls.SOCIAL} ORDER=${urls.ORDER} P2P=${urls.P2P}`);
  if (includeOrder) {
    console.log(
      `[soak] market Nvidia=${market.nvidia ? market.nvidia.tokenname || market.nvidia.tokenid : "not found"} ` +
        `USDT=${market.usdt ? market.usdt.tokenname || market.usdt.tokenid : "not found"} pairRead=${market.pairRead}`,
    );
  }

  const stabilityTimer = includeP2P || includeChain
    ? setInterval(() => void stabilityProbe().catch(() => undefined), stabilityMs)
    : null;
  void stabilityProbe().catch(() => undefined);

  let writeTimer = null;
  if (write && includeP2P) {
    writeTimer = setInterval(() => void writeCycle(), 300_000);
    setTimeout(() => void writeCycle(), 5_000);
  }

  const summaryTimer = setInterval(() => {
    const total = [...stats.values()].reduce((a, s) => a + s.count, 0);
    const errors = [...stats.values()].reduce((a, s) => a + s.errors, 0);
    const last = snapshots[snapshots.length - 1];
    const watch = last?.watch ? `watch=${last.watch.height}${last.watch.lastError ? ` err=${last.watch.lastError}` : ""}` : "watch=?";
    console.log(
      `[soak] ${Math.round((nowMs() - startedAt) / 1000)}s requests=${total} errors=${errors} ` +
        `errorRate=${total ? ((errors / total) * 100).toFixed(2) : "0.00"}% ${watch}`,
    );
  }, Math.max(10_000, Math.min(60_000, durationSec > 0 ? (durationSec * 1000) / 4 : 60_000)));

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  clearInterval(stabilityTimer);
  clearInterval(summaryTimer);
  clearInterval(writeTimer);
  await stabilityProbe().catch(() => undefined);
  if (rawJsonl) await new Promise((r) => rawJsonl.end(r));
  const report = buildReport();
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(
    `[soak] ${report.passed ? "PASS" : "FAIL"} requests=${report.requests} errors=${report.errors} ` +
      `errorRate=${(report.errorRate * 100).toFixed(2)}% steady.p95=${report.steady.p95}ms ` +
      `steady.p99=${report.steady.p99}ms rps=${report.throughputRps}`,
  );
  if (report.failures.length) for (const f of report.failures) console.error(`[soak] FAIL: ${f}`);
  console.log(`[soak] report ${outFile}${jsonl ? ` (samples ${jsonlFile})` : ""}`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((e) => {
  console.error(`[soak] fatal: ${e instanceof Error ? e.stack || e.message : String(e)}`);
  process.exit(1);
});
