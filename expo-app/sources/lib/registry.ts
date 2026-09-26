/**
 * `bigtangle-seeds` registry client (pure; no React Native/storage imports, so
 * it is unit-testable and shared by `services/discovery.ts`).
 *
 * The registry is the live node list: a newly published seed is picked up here
 * without rebuilding the client. Registries speak plain JSON (`POST
 * /serverinfolist`) and are queried over TLS or a same-origin proxy; an
 * unreachable registry is skipped.
 */
import { activeUrlsForChain, type RegistryEntry } from './endpoints';

/** Per-registry query timeout — a hung registry must never stall discovery. */
export const REGISTRY_TIMEOUT_MS = 5000;

/** Active node URLs for `chain` from one or more registries (union, deduped). */
export async function fetchRegistryNodes(
  registries: string[],
  chain: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REGISTRY_TIMEOUT_MS,
): Promise<string[]> {
  const urls: string[] = [];
  for (const registry of registries ?? []) {
    const base = (registry ?? '').trim().replace(/\/+$/, '');
    if (!base) continue;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/serverinfolist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: ctrl?.signal,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { serverInfoList?: RegistryEntry[] };
      urls.push(...activeUrlsForChain(body?.serverInfoList ?? [], chain));
    } catch {
      // registry unreachable/timed out — try the next / fall back to cached sources
    } finally {
      clearTimeout(timer);
    }
  }
  return [...new Set(urls)];
}
