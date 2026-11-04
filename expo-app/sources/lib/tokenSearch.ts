import type { TokenItem } from '@/types/api';
import { BC_DECIMALS } from '@/lib/tokenformat';

/**
 * Native BIG is the chain's own token (`bc`) and has **no** `searchExchangeTokens`
 * row, so the token pickers must add it locally. This is the shared rule behind
 * the `/trade` pair picker and the P2P "token to sell" field so the two cannot
 * drift (a P2P seller must be able to list BIG, exactly like a trader can pick
 * it).
 */
export const BIG_TOKEN: TokenItem = {
  tokenid: 'bc',
  tokenname: 'BIG',
  decimals: BC_DECIMALS,
};

/** `BIG`, `BIGTANGLE`, or the raw id `bc` (prefix match, case-insensitive). */
export function matchesBigToken(keyword: string): boolean {
  const want = keyword.trim().toUpperCase();
  return (
    want.length > 0 &&
    ('BIG'.startsWith(want) || 'BIGTANGLE'.startsWith(want) || want === 'BC')
  );
}

/**
 * Prepend the native BIG candidate when the query matches it, unless the search
 * already returned it. Generic so `/trade` can supply its richer MarketPrice
 * row and P2P its TokenItem.
 */
export function includeNativeBig<T extends { tokenid: string }>(
  rows: readonly T[],
  keyword: string,
  big: T,
): T[] {
  if (!matchesBigToken(keyword) || rows.some((r) => r.tokenid === big.tokenid)) {
    return [...rows];
  }
  return [big, ...rows];
}
