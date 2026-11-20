/**
 * Portfolio rows for the external assets.
 *
 * Pure so the home card can be tested without React: merge the distributor's
 * balances with the bundled registry, drop unknown ids, keep zero balances out
 * of the summary (a row of zeros is noise), and format with each asset's own
 * decimals rather than a shared guess.
 */

import { formatExternalAmount, type ExternalAsset } from './externalAssets';
import type { ExternalBalance } from '@/services/distributor';

export interface ExternalPortfolioRow {
  asset: ExternalAsset;
  symbol: string;
  /** Localized display amount. */
  amount: string;
  /** Raw smallest units, for sorting/tests. */
  raw: bigint;
}

export function mergeExternalBalances(
  assets: ExternalAsset[],
  balances: ExternalBalance[],
  locale = 'en',
): ExternalPortfolioRow[] {
  const rows: ExternalPortfolioRow[] = [];
  for (const asset of assets) {
    const balance = balances.find((b) => b.assetId === asset.id);
    if (!balance) continue;
    let raw: bigint;
    try {
      raw = BigInt(balance.available || '0');
    } catch {
      continue;
    }
    if (raw <= BigInt(0)) continue;
    rows.push({
      asset,
      symbol: asset.symbol,
      amount: formatExternalAmount(raw, asset, locale),
      raw,
    });
  }
  // Largest first; stable for equal amounts.
  return rows.sort((a, b) => (a.raw === b.raw ? a.symbol.localeCompare(b.symbol) : a.raw > b.raw ? -1 : 1));
}
