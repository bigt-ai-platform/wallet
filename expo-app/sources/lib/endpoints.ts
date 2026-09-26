/**
 * Endpoint health + ranking for L0 (main chain) / L1 (order-match) discovery.
 *
 * Pure helpers only (no fetch/Capacitor imports) so they are unit testable. The
 * network probe + cache live in `services/discovery.ts`; these functions turn
 * probe results into an ordered candidate list and manage cache staleness and
 * session demotion.
 *
 * The health definition mirrors the operator-side `bigtai/check/checkchain.sh`:
 * a node is serving only when `getChainNumber` returns HTTP 200, no `errorcode`
 * ("service is not ready"), and a `txReward.chainLength`. That chain length is
 * also the freshness rank key.
 */

/** Shape of a `getChainNumber` response, parsed as checkchain.sh does. */
export interface ChainProbe {
  /** Confirmed DAG length (`txReward.chainLength`) — the freshness key. */
  chainLength: number;
  finalizedChainLength: number | null;
  finalizedEpoch: number | null;
  justifiedEpoch: number | null;
  /** Head block hash (`txReward.blockHashHex`), hex. */
  head: string;
  /** Head block confirmed by the DAG. */
  confirmed: boolean | null;
  /** Protocol version reported in `txReward.version`. */
  version: number | null;
  /** Last justified (Casper FFG) block hash, hex. */
  justifiedBlockHash: string;
  /** Last finalized (Casper FFG) block hash, hex. */
  finalizedBlockHash: string;
}

export interface ProbeResult {
  url: string;
  /** Confirmed DAG chain length (`txReward.chainLength`) — the freshness key. */
  chainLength: number;
  latencyMs: number;
}

export interface RankedEndpoint extends ProbeResult {
  at: number;
}

/**
 * Parse a `getChainNumber` body the way `checkchain.sh` does. Returns null when
 * the node is not serving a chain head: an `errorcode` (e.g. 103 "service is
 * not ready") or a missing/zero `txReward.chainLength` — the silent-divergence
 * case that must not be counted as healthy.
 */
export function parseChainProbe(data: unknown): ChainProbe | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.errorcode) return null;
  let reward: unknown = d.txReward;
  if (typeof reward === 'string') {
    try {
      reward = JSON.parse(reward);
    } catch {
      reward = null;
    }
  }
  const r = (reward ?? {}) as Record<string, unknown>;
  const chainLength = Number(r.chainLength);
  if (!Number.isFinite(chainLength) || chainLength <= 0) return null;
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    chainLength,
    finalizedChainLength: num(d.finalizedChainLength),
    finalizedEpoch: num(d.finalizedEpoch),
    justifiedEpoch: num(d.justifiedEpoch),
    head: typeof r.blockHashHex === 'string' ? r.blockHashHex : '',
    confirmed: typeof r.confirmed === 'boolean' ? r.confirmed : null,
    version: num(r.version),
    justifiedBlockHash: typeof d.justifiedBlockHash === 'string' ? d.justifiedBlockHash : '',
    finalizedBlockHash: typeof d.finalizedBlockHash === 'string' ? d.finalizedBlockHash : '',
  };
}

/**
 * Rank healthy endpoints: most chain progress first, then lowest latency. All
 * responsive nodes are kept (they are valid failover targets); only nodes with
 * no chain (chainLength <= 0) are dropped when at least one node has progress.
 */
export function rankProbes(
  results: ProbeResult[],
  opts: { now?: number } = {},
): RankedEndpoint[] {
  const now = opts.now ?? 0;
  if (results.length === 0) return [];
  const maxLength = Math.max(...results.map((r) => r.chainLength));
  const usable = maxLength > 0 ? results.filter((r) => r.chainLength > 0) : results;
  return usable
    .sort((a, b) => b.chainLength - a.chainLength || a.latencyMs - b.latencyMs)
    .map((r) => ({ ...r, at: now }));
}

/** True when there is no usable cached ranking or it is older than `ttlMs`. */
export function cacheStale(
  cached: { at: number } | undefined | null,
  ttlMs: number,
  now: number,
): boolean {
  if (!cached) return true;
  return now - cached.at >= ttlMs;
}

/**
 * Build the ordered candidate list: an explicit user-preferred URL first, then
 * the cached ranking, then any remaining defaults. Duplicates are removed.
 */
export function orderEndpoints(
  defaults: string[],
  cached: RankedEndpoint[],
  preferred?: string,
): string[] {
  const out: string[] = [];
  const push = (u: string | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(preferred);
  for (const c of cached) push(c.url);
  for (const d of defaults) push(d);
  return out;
}

/** Move a failing endpoint to the end of the order (session demotion). */
export function demote(order: string[], url: string): string[] {
  const filtered = order.filter((u) => u !== url);
  if (order.includes(url)) filtered.push(url);
  return filtered;
}

/** Normalize a base URL to have exactly one trailing slash. */
export function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/** True for a Tor `.onion` endpoint (a fallback transport, not clear-net). */
export function isOnionUrl(url: string): boolean {
  return /(^|\/\/)[^/]*\.onion(:|\/|$)/i.test(url ?? '');
}

/** A `bigtangle-seeds` /serverinfolist entry. */
export interface RegistryEntry {
  url?: string;
  chain?: string;
  status?: string;
}

/**
 * Active node URLs for `chain` from a registry list: chain-matched first, then
 * unlabelled entries as a fallback. An entry advertising a different chain is
 * never returned.
 */
export function activeUrlsForChain(
  entries: RegistryEntry[] | null | undefined,
  chain: string,
): string[] {
  const matched: string[] = [];
  const unknown: string[] = [];
  for (const entry of entries ?? []) {
    const url = typeof entry?.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : '';
    if (!url) continue;
    if (entry.status && entry.status.toLowerCase() !== 'active') continue;
    const entryChain = typeof entry.chain === 'string' ? entry.chain.trim() : '';
    if (!entryChain) unknown.push(url);
    else if (!chain || entryChain.toLowerCase() === chain.toLowerCase()) matched.push(url);
  }
  return [...new Set([...matched, ...unknown])];
}

/** Clear-net candidates first; onion last (often unreachable, so never blocking). */
export function orderOnionLast(urls: string[]): string[] {
  const clear: string[] = [];
  const onion: string[] = [];
  for (const u of urls) (isOnionUrl(u) ? onion : clear).push(u);
  return [...clear, ...onion];
}
