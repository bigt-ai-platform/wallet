/**
 * L0/L1 endpoint discovery: probe the candidate nodes, rank by chain freshness
 * then latency, cache the ranking, and hand back an ordered list the request
 * layer can fail over through.
 *
 * Candidates bootstrap from the network's seed/entry-point list
 * (`constants/app.ts`). A user-pinned URL that is one of those candidates is
 * ordered first (custom URLs outside the set are used alone, so a different
 * network is never silently substituted). Ranking is refreshed in the
 * background when stale and a failing endpoint is demoted for the session.
 *
 * Health is defined the same way as the operator-side
 * `bigtai/check/checkchain.sh`: a node serves only with HTTP 200, no
 * `errorcode`, and a `txReward.chainLength` (see `parseChainProbe`). Selection
 * additionally applies the checkchains.sh pass criteria (spread, finality lag,
 * head agreement, advance rate — see `selectAndRank`).
 *
 * The whole loop is switchable: the `settings.autoDiscover` flag (default ON)
 * controls seed discovery, cache-driven ordering, and a background scheduler
 * (`startAutoSelection`) that re-probes every `AUTO_SELECT_INTERVAL_MS`. With
 * the flag off the wallet is manual: the preferred URL first, then the
 * candidate list in its fixed order — no probing, no seed refresh, no
 * cache-driven reordering.
 */
import { device } from '@/storage';
import {
  DEV_L0_URL,
  DEV_L1_URL,
  DNS_SEEDS_DOMAIN,
  DOH_URL,
  IS_DEV,
  IS_WEB_BROWSER,
  MAINNET_L0_URLS,
  MAINNET_L1_URLS,
  PROD_WEB_L0_BASE,
  PROD_WEB_L0_NODES,
  PROD_WEB_L1_BASE,
  PROD_WEB_L1_NODES,
  SEEDS_CHAIN_L0,
  SEEDS_CHAIN_L1,
  SEEDS_URLS,
} from '@/constants/app';
import { parseDohSeeds, type DohResponse } from '@/lib/dnsseeds';
import {
  cacheStale,
  demote,
  orderEndpoints,
  orderOnionLast,
  parseChainProbe,
  selectAndRank,
  withSlash,
  type ChainProbe,
  type ChainSample,
  type ProbeResult,
  type RankedEndpoint,
} from '@/lib/endpoints';
import { fetchRegistryNodes } from '@/lib/registry';
import { nodeNameForUrl } from '@/lib/chainstatus';

export { isOnionUrl } from '@/lib/endpoints';

export type Role = 'l0' | 'l1';

/** Cached ranking lifetime before a background refresh. */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** Per-candidate probe timeout. */
export const PROBE_TIMEOUT_MS = 4000;
/** Background re-selection cadence while auto-discover is on. */
export const AUTO_SELECT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Whether the wallet discovers and ranks servers by itself (default ON).
 * OFF = manual mode: the preferred URL first and the candidate list in its
 * fixed order, no seed refresh, no background probing.
 */
export function autoDiscoverEnabled(): boolean {
  return device.get(['settings', 'autoDiscover']) !== 'false';
}

/** Persist the auto-discover flag and re-arm the background scheduler. */
export function setAutoDiscoverEnabled(enabled: boolean): void {
  device.set(['settings', 'autoDiscover'], enabled ? 'true' : 'false');
  restartAutoSelection();
}

interface Cache {
  at: number;
  ranked: RankedEndpoint[];
}

interface SeedCache {
  at: number;
  urls: string[];
}

interface LearnedCache {
  at: number;
  urls: string[];
}

/** DNS-published seed resolution is refreshed on this cadence. */
export const DNS_SEED_TTL_MS = 60 * 60 * 1000;
/** Cap on remembered (learned) peers per role/network. */
export const LEARNED_MAX = 16;

const down = new Set<string>();
const refreshing = new Set<Role>();

function isTestnet(): boolean {
  return device.get(['settings', 'useTestnet']) === 'true';
}

/** Remembered peers are scoped per network so dev/mainnet/testnet never mix. */
function netTag(): string {
  if (IS_DEV) return 'dev';
  return isTestnet() ? 'test' : 'main';
}

/**
 * Peers this device actually reached before, most-recent first. Persisted so a
 * subsequently blocked seed never matters: after one good connection we keep a
 * way back in without any seed or DNS.
 */
export function learnedPeers(role: Role): string[] {
  const raw = device.get(['discovery-learned', netTag(), role]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LearnedCache;
    if (!parsed || !Array.isArray(parsed.urls)) return [];
    return parsed.urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
  } catch {
    return [];
  }
}

/** Record a successfully-used base as a durable fallback peer. */
export function rememberPeer(role: Role, url: string): void {
  const base = (url ?? '').trim().replace(/\/+$/, '');
  if (!base) return;
  const urls = [base, ...learnedPeers(role).filter((u) => u !== base)].slice(0, LEARNED_MAX);
  device.set(['discovery-learned', netTag(), role], JSON.stringify({ at: Date.now(), urls } satisfies LearnedCache));
}

/**
 * Static seed endpoints for a role, platform and network. Testnet/dev have a
 * single usable endpoint, so discovery is a no-op there. The web production
 * build lists every mainnet node via its same-origin per-node proxy path so
 * discovery can rank/fail over between them (each path is routed to one node by
 * the deploy Caddy/nginx; see PROD_WEB_L0_NODES / PROD_WEB_L1_NODES).
 */
function staticCandidates(role: Role): string[] {
  if (IS_DEV) return role === 'l0' ? [DEV_L0_URL] : [DEV_L1_URL];
  if (isTestnet()) return [];
  if (IS_WEB_BROWSER) {
    return (role === 'l0' ? PROD_WEB_L0_NODES : PROD_WEB_L1_NODES).map((n) => n.url);
  }
  return role === 'l0' ? MAINNET_L0_URLS.slice() : MAINNET_L1_URLS.slice();
}

/**
 * DNS seed resolution is a native-mainnet bootstrap: the browser build can only
 * reach its same-origin `/l0/`,`/l1/` proxy (the chain nodes send no CORS), so
 * remote seeds discovered via DNS would be unusable there.
 */
function dnsDiscoveryEnabled(): boolean {
  return !IS_DEV && !isTestnet() && !IS_WEB_BROWSER;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

function seedKey(role: Role): string[] {
  return ['discovery-seeds', role];
}

function txtName(role: Role): string {
  return `_bigtangle-${role}.${DNS_SEEDS_DOMAIN}`;
}

function srvName(role: Role): string {
  return `_bigtangle-${role}._tcp.${DNS_SEEDS_DOMAIN}`;
}

function readUrlCache(key: string[]): SeedCache | null {
  const raw = device.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SeedCache;
    if (!parsed || !Array.isArray(parsed.urls) || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function readSeedCache(role: Role): SeedCache | null {
  return readUrlCache(seedKey(role));
}

function registryKey(role: Role): string[] {
  return ['discovery-registry', netTag(), role];
}

function readRegistryCache(role: Role): SeedCache | null {
  return readUrlCache(registryKey(role));
}

/** Registry chain id for a role (L0 vs the wallet's order-match chain). */
function registryChain(role: Role): string {
  return role === 'l0' ? SEEDS_CHAIN_L0 : SEEDS_CHAIN_L1;
}

async function dohQuery(name: string, type: 'TXT' | 'SRV'): Promise<DohResponse | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DohResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the DNS-published seed list for a role (TXT + SRV, best effort). */
export async function fetchDnsSeeds(role: Role): Promise<string[]> {
  const [txt, srv] = await Promise.all([dohQuery(txtName(role), 'TXT'), dohQuery(srvName(role), 'SRV')]);
  return dedupe([...parseDohSeeds(txt), ...parseDohSeeds(srv)]);
}

async function refreshDnsSeeds(role: Role): Promise<void> {
  if (!dnsDiscoveryEnabled()) return;
  if (!cacheStale(readSeedCache(role), DNS_SEED_TTL_MS, Date.now())) return;
  const urls = await fetchDnsSeeds(role);
  if (urls.length > 0) {
    device.set(seedKey(role), JSON.stringify({ at: Date.now(), urls } satisfies SeedCache));
  }
}

/** Registry list lifetime before a refresh. */
export const REGISTRY_TTL_MS = 60 * 60 * 1000;

/**
 * Live node URLs for a role from the `bigtangle-seeds` registries
 * (`POST /serverinfolist`), so the compiled seeds are only a fallback. Requires
 * a TLS-reachable registry (see `SEEDS_URLS`).
 */
export async function fetchRegistrySeeds(role: Role): Promise<string[]> {
  if (!SEEDS_URLS.length) return [];
  return fetchRegistryNodes(SEEDS_URLS, registryChain(role));
}

async function refreshRegistrySeeds(role: Role): Promise<void> {
  if (!SEEDS_URLS.length) return;
  if (!cacheStale(readRegistryCache(role), REGISTRY_TTL_MS, Date.now())) return;
  const urls = await fetchRegistrySeeds(role);
  if (urls.length > 0) {
    device.set(registryKey(role), JSON.stringify({ at: Date.now(), urls } satisfies SeedCache));
  }
}

/**
 * Candidate endpoints for a role: static seeds, DNS-published seeds (native
 * mainnet), and peers this device reached before. Learned peers make a
 * subsequently blocked seed harmless — one prior connection is enough.
 */
export function candidatesFor(role: Role): string[] {
  const base = staticCandidates(role);
  const learned = learnedPeers(role);
  const dns = dnsDiscoveryEnabled() ? readSeedCache(role)?.urls ?? [] : [];
  // The registry also works on web when SEEDS_URLS is a same-origin path.
  const registry = SEEDS_URLS.length ? readRegistryCache(role)?.urls ?? [] : [];
  return orderOnionLast(dedupe([...base, ...dns, ...registry, ...learned]));
}

/**
 * Candidate endpoints for the sidebar "Chains" page. On the web production
 * build this expands to every mainnet node via its same-origin proxy path
 * (each `handle_path` block in the deploy Caddy/nginx routes to one node), so
 * the page lists all available chains — not just the single default `/l0/`,
 * `/l1/` upstream that the request layer uses. All other platforms share the
 * ordinary candidate set.
 */
export function networkCandidates(role: Role): string[] {
  if (IS_WEB_BROWSER && !IS_DEV) {
    const nodes = role === 'l0' ? PROD_WEB_L0_NODES : PROD_WEB_L1_NODES;
    return nodes.map((n) => n.url);
  }
  return candidatesFor(role);
}

/**
 * The node (eu1…eu5 / ordereu1…ordereu5) that automatic selection currently
 * prefers for a role — i.e. the first of `orderedBases`, which is the top
 * `selectAndRank` result when auto-discover is on, or the default/primary
 * otherwise. Returns null when there is no candidate or it doesn't map to a
 * known node. Used by the Chains page to mark the selected row.
 */
export function selectedNodeName(role: Role): string | null {
  const [base] = orderedBases(role);
  return base ? nodeNameForUrl(base, role) : null;
}

function cacheKey(role: Role): string[] {
  return ['discovery', role];
}

function readCache(role: Role): Cache | null {
  const raw = device.get(cacheKey(role));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Cache;
    if (!parsed || !Array.isArray(parsed.ranked) || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function samplesKey(role: Role): string[] {
  return ['discovery-samples', netTag(), role];
}

/** Last probe of each URL (per network + role), for stall detection. */
function readSamples(role: Role): Record<string, ChainSample> {
  const raw = device.get(samplesKey(role));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ChainSample>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ChainSample> = {};
    for (const [url, s] of Object.entries(parsed)) {
      if (s && typeof s.at === 'number' && typeof s.chainLength === 'number') out[url] = s;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSamples(role: Role, results: ProbeResult[], now: number): void {
  const out: Record<string, ChainSample> = {};
  for (const r of results) out[r.url] = { at: now, chainLength: r.chainLength };
  device.set(samplesKey(role), JSON.stringify(out));
}

/**
 * Fetch + parse one endpoint's `getChainNumber`. A node is healthy only when it
 * is HTTP 200, reports no `errorcode`, and exposes a `txReward.chainLength`
 * (same rule as `bigtai/check/checkchain.sh`). Shared by `probe` (health) and
 * `endpointInfo` (full chain state for the status page).
 */
async function fetchProbe(
  url: string,
  timeoutMs: number,
): Promise<{ probe: ChainProbe; latencyMs: number } | null> {
  const base = withSlash(url);
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}getChainNumber`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    const parsed = parseChainProbe(await res.json());
    if (!parsed) return null;
    return { probe: parsed, latencyMs: Date.now() - t0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one endpoint's health + progress via the cheap `getChainNumber`. */
export async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult | null> {
  const r = await fetchProbe(url, timeoutMs);
  return r
    ? {
        url,
        chainLength: r.probe.chainLength,
        latencyMs: r.latencyMs,
        finalizedChainLength: r.probe.finalizedChainLength,
        head: r.probe.head,
      }
    : null;
}

/** Full `getChainNumber` state of one endpoint (for the chain-status page). */
export interface EndpointInfo {
  url: string;
  latencyMs: number;
  probe: ChainProbe;
}

export async function endpointInfo(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<EndpointInfo | null> {
  const r = await fetchProbe(url, timeoutMs);
  return r ? { url, latencyMs: r.latencyMs, probe: r.probe } : null;
}

export interface EndpointHealth {
  url: string;
  healthy: boolean;
  chainLength: number;
  latencyMs: number;
}

/**
 * Check the health of one specific endpoint (the one currently in use). Returns
 * the same verdict as `probe`, shaped for display/telemetry.
 */
export async function endpointHealth(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<EndpointHealth> {
  const t0 = Date.now();
  const result = await probe(url, timeoutMs);
  if (result) {
    return { url, healthy: true, chainLength: result.chainLength, latencyMs: result.latencyMs };
  }
  return { url, healthy: false, chainLength: 0, latencyMs: Date.now() - t0 };
}

/** Health of the endpoint the request layer would use first for a role. */
export async function currentEndpointHealth(
  role: Role,
  preferred?: string,
): Promise<EndpointHealth | null> {
  const [first] = orderedBases(role, preferred);
  if (!first) return null;
  return endpointHealth(first);
}

/**
 * Probe every candidate in parallel, apply the checkchains.sh selection
 * criteria (`selectAndRank`), and persist the ranked result + fresh samples.
 * The DNS-published seed list is refreshed first (native mainnet), so newly
 * published seeds are folded into the candidate set. No-op in manual mode
 * (auto-discover off) and while another refresh for the role is in flight.
 */
export async function refresh(role: Role): Promise<RankedEndpoint[]> {
  if (refreshing.has(role)) return readCache(role)?.ranked ?? [];
  refreshing.add(role);
  try {
    if (!autoDiscoverEnabled()) return [];
    await Promise.all([refreshDnsSeeds(role), refreshRegistrySeeds(role)]).catch(() => {});
    const defaults = candidatesFor(role);
    if (defaults.length <= 1) return [];
    const results = (await Promise.all(defaults.map((u) => probe(u)))).filter(
      (r): r is ProbeResult => r !== null,
    );
    const now = Date.now();
    const { ranked } = selectAndRank(results, { now, prev: readSamples(role) });
    writeSamples(role, results, now);
    if (ranked.length > 0) {
      device.set(cacheKey(role), JSON.stringify({ at: now, ranked } satisfies Cache));
    }
    return ranked;
  } finally {
    refreshing.delete(role);
  }
}

function backgroundRefresh(role: Role): void {
  void refresh(role).catch(() => {});
}

/**
 * Re-probe both roles now (the background scheduler tick + the immediate
 * selection when the setting is turned on). Silent on failure.
 */
export async function selectNow(): Promise<void> {
  if (!autoDiscoverEnabled()) return;
  await Promise.all([refresh('l0'), refresh('l1')]).catch(() => {});
}

let autoTimer: ReturnType<typeof setInterval> | null = null;

function autoSelectTick(): void {
  void selectNow().catch(() => {});
}

/** Arm the background re-selection loop (idempotent, no-op when the setting is off). */
export function startAutoSelection(): void {
  if (autoTimer || !autoDiscoverEnabled()) return;
  autoSelectTick();
  autoTimer = setInterval(autoSelectTick, AUTO_SELECT_INTERVAL_MS);
}

/** Disarm the background re-selection loop. */
export function stopAutoSelection(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

/** Re-arm the loop after the setting changed; disabled = disarmed. */
export function restartAutoSelection(): void {
  stopAutoSelection();
  if (autoDiscoverEnabled()) startAutoSelection();
}

/**
 * Normalize a user-pinned/default base for the candidate check. On the web
 * production build the pinned default is the bare proxy path (`/l0/`, `/l1/`),
 * which is not a specific node — treat it as "no preference" so discovery's
 * ranking decides (healthiest node first) instead of short-circuiting to one
 * upstream. A genuinely custom pinned URL is returned unchanged.
 */
function normalizePreferred(role: Role, preferred?: string): string | undefined {
  if (!preferred) return preferred;
  if (IS_WEB_BROWSER && !IS_DEV) {
    const base = role === 'l0' ? PROD_WEB_L0_BASE : PROD_WEB_L1_BASE;
    if (preferred === base || preferred === base.replace(/\/+$/, '')) return undefined;
  }
  return preferred;
}

/**
 * Ordered candidate bases for a role: user-preferred first, cached ranking
 * next, remaining defaults last. Triggers a background refresh when the cache
 * is missing/stale. Manual mode (auto-discover off) skips the discovery
 * ordering and refresh: preferred URL first, then the candidate list as-is.
 */
export function orderedBases(role: Role, preferred?: string): string[] {
  const pref = normalizePreferred(role, preferred);
  const defaults = candidatesFor(role);
  if (defaults.length === 0) return pref ? [pref] : [];
  // A user-pinned endpoint outside the known set (custom node/network) is used
  // alone — never silently fail over to a different network's defaults.
  if (pref && !defaults.includes(pref)) return [pref];
  if (defaults.length === 1) return defaults;

  if (!autoDiscoverEnabled()) {
    const manual = pref ? [pref, ...defaults.filter((d) => d !== pref)] : defaults.slice();
    let manualOrder = manual;
    for (const url of down) manualOrder = demote(manualOrder, url);
    return manualOrder;
  }

  const cached = readCache(role);
  if (cacheStale(cached, CACHE_TTL_MS, Date.now())) backgroundRefresh(role);

  let order = orderEndpoints(defaults, cached?.ranked ?? [], pref);
  for (const url of down) order = demote(order, url);
  return order;
}

/** Demote an endpoint that just failed so later requests try it last. */
export function markDown(role: Role, url: string): void {
  down.add(url);
}
