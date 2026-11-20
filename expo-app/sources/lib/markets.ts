/**
 * Order-book markets for the tradable external assets.
 *
 * The chain calls the quote token `orderBaseToken`. In this codebase that is
 * the **quote** (the right-hand side of `GOLD/HKD`), so `quote` below always
 * means "the base token the order is priced in".
 *
 * `NetworkParameters.getOrderPriceShift` returns **0** when the quote is `bc`
 * and **6** for every other quote, so no chain change is needed to add a
 * market. What the chain *does* constrain is the width of the `long` fields
 * (`OrderOpenInfo.offerValue` / `targetValue` / `price`); helpers below make
 * that ceiling explicit instead of letting it overflow at runtime.
 *
 * Launch set: five fiat-quoted pairs plus the `bc` pairs (design §4.1). Depth
 * beats breadth — do not grow this by cartesian product.
 */

import { orderPriceShift } from './tokenformat';

/** Quote ids are external-asset ids, or `bc` for the native token. */
export type QuoteId = 'hkd' | 'usd' | 'bc';

export interface MarketDefinition {
  /** Stable key, e.g. `GOLDHKD`. */
  id: string;
  /** External asset id being offered (`lib/externalAssets`). */
  asset: string;
  /** Order-book base token (the quote). */
  quote: QuoteId;
  /** Display label, asset first, quote second. */
  label: string;
  /** Minimum price step in display units. */
  tick: string;
  /** Maximum order size in display units (informational; the raw cap wins). */
  maxOrder: string;
}

export const MARKETS: MarketDefinition[] = [
  { id: 'ETHHKD', asset: 'eth', quote: 'hkd', label: 'ETH/HKD', tick: '0.01', maxOrder: '1000' },
  { id: 'ETHUSD', asset: 'eth', quote: 'usd', label: 'ETH/USD', tick: '0.01', maxOrder: '1000' },
  { id: 'GOLDHKD', asset: 'gold', quote: 'hkd', label: 'GOLD/HKD', tick: '0.01', maxOrder: '1000' },
  { id: 'GOLDUSD', asset: 'gold', quote: 'usd', label: 'GOLD/USD', tick: '0.01', maxOrder: '1000' },
  { id: 'HKDUSD', asset: 'hkd', quote: 'usd', label: 'HKD/USD', tick: '0.000001', maxOrder: '1000000' },
  { id: 'ETHBC', asset: 'eth', quote: 'bc', label: 'ETH/BC', tick: '0.000001', maxOrder: '1000' },
  { id: 'GOLDBC', asset: 'gold', quote: 'bc', label: 'GOLD/BC', tick: '0.000001', maxOrder: '1000' },
  { id: 'HKDBC', asset: 'hkd', quote: 'bc', label: 'HKD/BC', tick: '0.000001', maxOrder: '1000000' },
];

/**
 * Symbols the trade screen resolves into quote tokens. Market quotes first,
 * then the legacy quotes that must keep working. `bc` is built in and is not
 * looked up by symbol.
 */
const LEGACY_QUOTE_SYMBOLS = ['USDT', 'CNY'];

export function quoteSymbols(): string[] {
  const fromMarkets = MARKETS.map((m) => m.quote)
    .filter((q): q is Exclude<QuoteId, 'bc'> => q !== 'bc')
    .map((q) => q.toUpperCase());
  return [...new Set([...fromMarkets, ...LEGACY_QUOTE_SYMBOLS])];
}

export function findMarket(id: string): MarketDefinition | undefined {
  const key = (id ?? '').trim().toUpperCase();
  return MARKETS.find((m) => m.id.toUpperCase() === key);
}

export function marketsFor(assetId: string): MarketDefinition[] {
  const key = (assetId ?? '').trim().toLowerCase();
  return MARKETS.filter((m) => m.asset === key);
}

/** Default market for an asset, or undefined when it has none. */
export function defaultMarketFor(assetId: string): MarketDefinition | undefined {
  return marketsFor(assetId)[0];
}

/**
 * The `long` ceiling for every order field (`offerValue`, `targetValue`,
 * `price` are signed 64-bit in `OrderOpenInfo`).
 */
export const MAX_ORDER_RAW = (1n << 63n) - 1n;

/** Raw order price already carries `10^(assetDecimals + shift)`. */
export function orderPriceDecimals(assetDecimals: number, quote: QuoteId | string): number {
  return assetDecimals + orderPriceShift(quote === 'bc' ? 'bc' : 'token');
}

/** Largest display amount an order can escrow at `decimals`. */
export function maxDisplayAmount(decimals: number): bigint {
  return MAX_ORDER_RAW / 10n ** BigInt(Math.max(0, decimals));
}

/** Largest display price at `decimals` for `quote`. */
export function maxDisplayPrice(decimals: number, quote: QuoteId | string): bigint {
  return MAX_ORDER_RAW / 10n ** BigInt(orderPriceDecimals(decimals, quote));
}

/** True when a raw value still fits the on-chain `long`. */
export function fitsLong(raw: bigint): boolean {
  return raw >= 0n && raw <= MAX_ORDER_RAW;
}

/**
 * Guard for call sites that build raw values from user input. Returns a stable
 * error code ('errAmount' | 'errPrice') or null.
 */
export function checkLongBounds(raw: bigint, kind: 'amount' | 'price'): string | null {
  if (fitsLong(raw)) return null;
  return kind === 'amount' ? 'errAmount' : 'errPrice';
}
