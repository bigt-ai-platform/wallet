/**
 * Chain-status presentation helpers for the sidebar "Chains" page.
 *
 * Pure (no fetch/react-native/Capacitor imports) so they are unit testable. The
 * network probe lives in `services/discovery.ts`; these helpers only build the
 * display rows from the discovered candidates + configured L1 chains and
 * normalize URLs for dedupe.
 */

import type { ChainRole } from 'chain-discovery';

export type { ChainRole };

export interface ChainTarget {
  /** Stable identity: `${role}:${normalizeUrl(url)}`. */
  key: string;
  role: ChainRole;
  /** "L0" for the main chain, the configured chain name for L1. */
  name: string;
  url: string;
}

/** Minimal shape of a configured L1 chain (see types/api L1ChainConfig). */
export interface L1ChainLike {
  name?: string;
  url: string;
}

/** Compact host label: strip the scheme, path and trailing slash. */
export function hostOf(url: string): string {
  const s = (url ?? '').trim();
  if (!s) return '';
  const noScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return noScheme.replace(/\/+$/, '') || s;
}

/** Normalize a base URL for identity/merge (lowercase, no trailing slash). */
export function normalizeUrl(url: string): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Shorten a hex hash/id for display, keeping both ends. */
export function shortHash(hash: string | null | undefined, size = 8): string {
  const h = (hash ?? '').trim();
  if (!h) return '';
  if (h.length <= size * 2 + 1) return h;
  return `${h.slice(0, size)}…${h.slice(-size)}`;
}

/**
 * Mainnet node names per role and every address the same node answers on: its
 * public DNS name and the raw address it publishes in the live peer/seed
 * registry (`POST /serverinfolist`).
 *
 * This is the single node table: `constants/app.ts` derives the web per-node
 * proxy paths from it, and discovery maps a registry peer (`http://ip:port`)
 * back to `/l0/<name>/` through it, because a browser can only reach a node
 * through that same-origin proxy. Keep the names in sync with the `/l0|/l1`
 * proxy blocks in deploy/region.sh + deploy/nginx.conf — a name with no proxy
 * block probes offline on web. Social has no Chains-page rows.
 */
const MAINNET_NODES: Record<'l0' | 'l1', Record<string, string[]>> = {
  l0: {
    eu1: ['eu1.bigtangle.org', '85.214.37.95'],
    eu2: ['eu2.bigtangle.org', '85.215.91.140'],
    hk1: ['hk1.bigtangle.org', '43.129.198.77'],
  },
  l1: {
    ordereu1: ['ordereu1.bigtangle.org', '85.214.37.95'],
    ordereu2: ['ordereu2.bigtangle.org', '85.215.91.140'],
    orderhk1: ['orderhk1.bigtangle.org', '43.135.48.72'],
  },
};

/** Node names (eu1, eu2, hk1 / ordereu1, ordereu2, orderhk1) per role. */
export function nodeNames(role: ChainRole): string[] {
  if (role !== 'l0' && role !== 'l1') return [];
  return Object.keys(MAINNET_NODES[role]);
}

/** Same-origin proxy path for a node (`eu2` + `l0` → `/l0/eu2/`). */
export function proxyBaseForNode(role: ChainRole, name: string): string {
  return `/${role}/${name}/`;
}

/**
 * The node a base URL refers to, or null. Handles the web per-node proxy paths
 * (`/l0/eu2/`), the bare web primary (`/l0/` → eu1), native/mainnet hosts
 * (`https://eu2.bigtangle.org` → eu2) and the raw registry addresses
 * (`http://85.215.91.140:8082` → eu2).
 */
export function nodeNameForUrl(url: string, role: ChainRole): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  const nodes = nodeNames(role);
  if (nodes.length === 0) return null;
  for (const n of nodes) if (raw.includes(`/${n}/`)) return n;
  const trimmed = raw.replace(/\/+$/, '');
  if (role === 'l0' && trimmed === '/l0') return 'eu1';
  if (role === 'l1' && trimmed === '/l1') return 'ordereu1';
  const host = hostOf(raw).split('/')[0].split(':')[0].toLowerCase();
  const label = host.split('.')[0];
  if (nodes.includes(label)) return label;
  const entries = MAINNET_NODES[role as 'l0' | 'l1'];
  for (const n of nodes) {
    if (entries[n].some((h) => h.toLowerCase() === host)) return n;
  }
  return null;
}

/**
 * The same-origin proxy base for any URL of a known node, or null when the
 * browser has no way to reach it (see MAINNET_NODES). Also normalizes the bare
 * primary alias (`/l0/` → `/l0/eu1/`) and old per-node paths from an earlier
 * deployment (eu3…eu5, ordereu3…ordereu5 → null), so callers can dedupe
 * against the compiled node rows instead of showing a chain of their own.
 */
export function proxyBaseForUrl(url: string, role: ChainRole): string | null {
  const name = nodeNameForUrl(url, role);
  return name ? proxyBaseForNode(role, name) : null;
}

/**
 * Build the ordered chain-status rows: every L0 candidate, then every
 * configured L1 chain followed by the shared L1 candidates. Rows are deduped
 * per role; an L1 URL matching a configured chain carries that chain's name
 * (empty names fall back to "L1"). L0 rows are named "L0" unless `l0Chains`
 * supplies names (the web build passes its per-node proxies so each row shows
 * its node name).
 */
export function buildChainTargets(
  l0Candidates: string[],
  l1Chains: L1ChainLike[],
  l1Candidates: string[],
  l0Chains: L1ChainLike[] = [],
): ChainTarget[] {
  const out: ChainTarget[] = [];
  const seen = new Set<string>();

  const push = (role: ChainRole, name: string, url: string) => {
    const raw = (url ?? '').trim();
    if (!raw) return;
    const key = `${role}:${normalizeUrl(raw)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, role, name, url: raw });
  };

  const l0NameByUrl = new Map<string, string>();
  for (const c of l0Chains) {
    if (!c?.url?.trim()) continue;
    l0NameByUrl.set(normalizeUrl(c.url), (c.name ?? '').trim() || 'L0');
  }
  for (const url of l0Candidates) push('l0', l0NameByUrl.get(normalizeUrl(url)) || 'L0', url);

  const nameByUrl = new Map<string, string>();
  for (const c of l1Chains) {
    if (!c?.url?.trim()) continue;
    nameByUrl.set(normalizeUrl(c.url), (c.name ?? '').trim() || 'L1');
  }
  for (const c of l1Chains) push('l1', nameByUrl.get(normalizeUrl(c.url)) || 'L1', c.url);
  for (const url of l1Candidates) push('l1', nameByUrl.get(normalizeUrl(url)) || 'L1', url);

  return out;
}
