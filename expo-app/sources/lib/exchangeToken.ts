import type { TokenItem } from '@/types/api';

interface TokenSearchResult {
  success: boolean;
  data?: TokenItem[];
}

/**
 * Exact token-name lookup across search providers in order. L1 metadata comes
 * first; the L0 index supplies tokens the bridge wrapped onto L1 without a
 * local token-index row (for example USDT).
 */
export async function findExchangeToken(
  name: string,
  searches: Array<(keyword?: string) => Promise<TokenSearchResult>>,
): Promise<TokenItem | undefined> {
  const want = name.trim().toUpperCase();
  for (const search of searches) {
    try {
      const res = await search(name);
      const hit = res.success && res.data
        ? res.data.find((tk) => (tk.tokenname || '').trim().toUpperCase() === want)
        : undefined;
      if (hit?.tokenid) return hit;
    } catch {
      // Try the next provider; one chain being unavailable is not fatal.
    }
  }
  return undefined;
}
