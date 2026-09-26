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
 * `errorcode`, and a `txReward.chainLength` (see `parseChainProbe`).
 */
import { Platform } from 'react-native';
import { device } from '@/storage';
import {
  DEV_L0_URL,
  DEV_L1_URL,
  DNS_SEEDS_DOMAIN,
  DOH_URL,
  IS_DEV,
  MAINNET_L0_URLS,
  MAINNET_L1_URLS,
  PROD_WEB_L0_BASE,
  PROD_WEB_L1_BASE,
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
  rankProbes,
  withSlash,
  type ProbeResult,
  type RankedEndpoint,
} from '@/lib/endpoints';
import { fetchRegistryNodes } from '@/lib/registry';

export { isOnionUrl } from '@/lib/endpoints';

export type Role = 'l0' | 'l1';

/** Cached ranking lifetime before a background refresh. */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** Per-candidate probe timeout. */
export const PROBE_TIMEOUT_MS = 4000;

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
const IS_WEB = Platform.OS === 'web';

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
 * single usable endpoint, so discovery is a no-op there.
 */
function staticCandidates(role: Role): string[] {
  if (IS_DEV) return role === 'l0' ? [DEV_L0_URL] : [DEV_L1_URL];
  if (isTestnet()) return [];
  if (IS_WEB) return role === 'l0' ? [PROD_WEB_L0_BASE] : [PROD_WEB_L1_BASE];
  return role === 'l0' ? MAINNET_L0_URLS.slice() : MAINNET_L1_URLS.slice();
}

/**
 * DNS seed resolution is a native-mainnet bootstrap: the browser build can only
 * reach its same-origin `/l0/`,`/l1/` proxy (the chain nodes send no CORS), so
 * remote seeds discovered via DNS would be unusable there.
 */
function dnsDiscoveryEnabled(): boolean {
  return !IS_DEV && !isTestnet() && !IS_WEB;
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

/**
 * Probe one endpoint's health + progress via the cheap `getChainNumber`. A node
 * is healthy only when it is HTTP 200, reports no `errorcode`, and exposes a
 * `txReward.chainLength` (same rule as `bigtai/check/checkchain.sh`).
 */
export async function probe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult | null> {
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
    return { url, chainLength: parsed.chainLength, latencyMs: Date.now() - t0 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
 * Probe every candidate in parallel and persist the ranked result. The
 * DNS-published seed list is refreshed first (native mainnet), so newly
 * published seeds are folded into the candidate set.
 */
export async function refresh(role: Role): Promise<RankedEndpoint[]> {
  await Promise.all([refreshDnsSeeds(role), refreshRegistrySeeds(role)]).catch(() => {});
  const defaults = candidatesFor(role);
  if (defaults.length <= 1) return [];
  const results = (await Promise.all(defaults.map((u) => probe(u)))).filter(
    (r): r is ProbeResult => r !== null,
  );
  const ranked = rankProbes(results, { now: Date.now() });
  if (ranked.length > 0) {
    device.set(cacheKey(role), JSON.stringify({ at: Date.now(), ranked } satisfies Cache));
  }
  return ranked;
}

function backgroundRefresh(role: Role): void {
  if (refreshing.has(role)) return;
  refreshing.add(role);
  void refresh(role)
    .catch(() => {})
    .finally(() => refreshing.delete(role));
}

/**
 * Ordered candidate bases for a role: user-preferred first, cached ranking
 * next, remaining defaults last. Triggers a background refresh when the cache
 * is missing/stale.
 */
export function orderedBases(role: Role, preferred?: string): string[] {
  const defaults = candidatesFor(role);
  if (defaults.length === 0) return preferred ? [preferred] : [];
  // A user-pinned endpoint outside the known set (custom node/network) is used
  // alone — never silently fail over to a different network's defaults.
  if (preferred && !defaults.includes(preferred)) return [preferred];
  if (defaults.length === 1) return defaults;

  const cached = readCache(role);
  if (cacheStale(cached, CACHE_TTL_MS, Date.now())) backgroundRefresh(role);

  let order = orderEndpoints(defaults, cached?.ranked ?? [], preferred);
  for (const url of down) order = demote(order, url);
  return order;
}

/** Demote an endpoint that just failed so later requests try it last. */
export function markDown(role: Role, url: string): void {
  down.add(url);
}
