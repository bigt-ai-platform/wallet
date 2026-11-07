import { toBigInt } from './amountformat';

/**
 * Per-token balance summary for the balance screen. Port of the server page's
 * aggregated view (`WalletBalanceAction.balancesAdd` + `getTokensumUnspent`):
 *
 * - only **unspent** outputs contribute to the balance, so the "history" mode
 *   can list spent outputs without inflating the totals;
 * - a token whose outputs are all spent still gets a row (with a 0 total),
 *   because the Java `Tokensums` map is filled for spent outputs as well;
 * - the layer list names the layers that actually hold the balance (a token
 *   with a spent L1 output and an unspent L0 output lists only L0).
 */
export interface BalanceRow {
  tokenid?: string;
  tokenname?: string;
  value: string;
  spent?: boolean;
  /** Layer holding the output (omitted on the public page, which is L0 only). */
  layer?: number;
}

export interface TokenBalance {
  tokenId: string;
  tokenName: string;
  total: bigint;
  /** Unspent outputs behind `total`. */
  count: number;
  /** Layers holding unspent outputs, ascending. */
  layers: number[];
}

export function summarizeBalances(rows: Iterable<BalanceRow>): TokenBalance[] {
  const map = new Map<string, TokenBalance>();
  for (const u of rows) {
    const tokenId = u.tokenid || 'unknown';
    const cur = map.get(tokenId) || {
      tokenId,
      tokenName: u.tokenname || tokenId.slice(0, 8),
      total: BigInt(0),
      count: 0,
      layers: [],
    };
    if (!u.spent) {
      cur.total += toBigInt(u.value);
      cur.count += 1;
      if (u.layer != null && !cur.layers.includes(u.layer)) cur.layers.push(u.layer);
    }
    map.set(tokenId, cur);
  }
  return Array.from(map.values())
    .map((t) => ({ ...t, layers: [...t.layers].sort((a, b) => a - b) }))
    .sort((a, b) =>
      a.total === b.total ? a.tokenId.localeCompare(b.tokenId) : a.total > b.total ? -1 : 1
    );
}

/**
 * Sign shown in front of the amounts, matching the Java page's
 * `getAddress()`: "+" for the received (to-address) balance, "−" (U+2212) for
 * the sent (from-address) balance.
 */
export function directionSign(sent: boolean): string {
  return sent ? '−' : '+';
}
