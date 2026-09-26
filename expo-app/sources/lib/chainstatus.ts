/**
 * Chain-status presentation helpers for the sidebar "Chains" page.
 *
 * Pure (no fetch/react-native/Capacitor imports) so they are unit testable. The
 * network probe lives in `services/discovery.ts`; these helpers only build the
 * display rows from the discovered candidates + configured L1 chains and
 * normalize URLs for dedupe.
 */

export type ChainRole = 'l0' | 'l1';

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
 * Build the ordered chain-status rows: every L0 candidate, then every
 * configured L1 chain followed by the shared L1 candidates. Rows are deduped
 * per role; an L1 URL matching a configured chain carries that chain's name
 * (empty names fall back to "L1").
 */
export function buildChainTargets(
  l0Candidates: string[],
  l1Chains: L1ChainLike[],
  l1Candidates: string[],
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

  for (const url of l0Candidates) push('l0', 'L0', url);

  const nameByUrl = new Map<string, string>();
  for (const c of l1Chains) {
    if (!c?.url?.trim()) continue;
    nameByUrl.set(normalizeUrl(c.url), (c.name ?? '').trim() || 'L1');
  }
  for (const c of l1Chains) push('l1', nameByUrl.get(normalizeUrl(c.url)) || 'L1', c.url);
  for (const url of l1Candidates) push('l1', nameByUrl.get(normalizeUrl(url)) || 'L1', url);

  return out;
}
