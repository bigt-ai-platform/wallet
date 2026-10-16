import type { TokenItem } from '@/types/api';

/**
 * Collapse `searchTokens` records into one row per token.
 *
 * A token is issued once per emission: the server returns the same `tokenid`
 * again with an incremented `tokenindex` and a per-emission `amount`. Its total
 * supply is the sum over those emissions — Java `getTokenAmountMap` computes it
 * and ships it as `amountMap[tokenid]`. Prefer that map; otherwise sum the
 * records with BigInt so a large supply never loses precision. The first record
 * supplies the metadata (name, decimals, description).
 */
export function collapseTokenEmissions(
  tokens: TokenItem[],
  amountMap: Record<string, string | number> = {},
): TokenItem[] {
  const byId = new Map<string, TokenItem>();
  const summed = new Map<string, bigint>();
  for (const tk of tokens) {
    if (!byId.has(tk.tokenid)) byId.set(tk.tokenid, { ...tk });
    if (tk.amount != null) {
      try {
        summed.set(tk.tokenid, (summed.get(tk.tokenid) ?? 0n) + BigInt(String(tk.amount)));
      } catch {
        /* non-numeric amount — skip it in the fallback sum */
      }
    }
  }
  return [...byId.values()].map((tk) => ({
    ...tk,
    amount: amountMap[tk.tokenid] ?? summed.get(tk.tokenid)?.toString() ?? tk.amount,
  }));
}
