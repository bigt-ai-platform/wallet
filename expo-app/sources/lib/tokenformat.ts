/**
 * Per-token amount formatting, mirroring the Java reference:
 *
 * - Token.decimals default 0 (net.bigt-ai.core.Token), the base token "bc"
 *   (BIG) uses NetworkParameters.BIGT_AI_DECIMAL = 6.
 * - Amounts are formatted the way Java's
 *   `MonetaryFormat.FIAT.format(value, token.getDecimals())` does
 *   (shift 0, minDecimals 0 → trailing zeros trimmed).
 */
import { NetworkParameters } from 'bigt-ai-ts';

/** Decimals of the base token "bc" (BIG). */
export const BC_DECIMALS = NetworkParameters.BIGT_AI_DECIMAL;

/**
 * Effective decimals for a token: the token metadata value when present,
 * else BIGT_AI_DECIMAL for "bc", else 0 (Java Token default).
 */
export function decimalsFor(tokenid: string, tokenDecimals?: number | null): number {
  if (typeof tokenDecimals === 'number' && tokenDecimals >= 0) {
    return tokenDecimals;
  }
  return tokenid === 'bc' ? BC_DECIMALS : 0;
}

/**
 * Extra scale shift of the raw order price for a quote token, mirroring Java
 * `NetworkParameters.getOrderPriceShift`: the raw long stored on chain is
 * `price * 10^(tokenDecimals + shift)`, with shift 0 when the quote is the
 * base token "bc" and 6 for every token quote (e.g. CNY).
 */
export function orderPriceShift(baseTokenId: string): number {
  return baseTokenId === NetworkParameters.BIGT_AI_TOKENID_STRING ? 0 : 6;
}

/**
 * Decimals of the raw order price: the **quote** token's decimals plus the
 * quote shift. Java formats the ticker price with
 * `base.getDecimals() + getOrderPriceShift(base)` (Wallet.java:1868-1872);
 * the traded token's decimals scale only the quantity. Mixing these up
 * mis-prices every pair whose two tokens have different decimals.
 */
export function orderPriceDecimals(quoteDecimals: number, quoteTokenId: string): number {
  return quoteDecimals + orderPriceShift(quoteTokenId);
}

/** The SDK serializes order longs through a JS `number`. */
const MAX_SIGNED_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** The raw quote amount the SDK will compute for a price/quantity pair. */
export function orderRawTotal(
  priceRaw: bigint,
  amountRaw: bigint,
  tokenDecimals: number,
  quoteTokenId: string,
): bigint {
  const divisor = 10n ** BigInt(tokenDecimals + orderPriceShift(quoteTokenId));
  return (priceRaw * amountRaw) / divisor;
}

/**
 * True when every raw field the SDK will convert to `number` is exactly
 * representable. The SDK checks the total against MAX_SAFE_INTEGER; price and
 * quantity are converted with `Number(...)` without a check, so reject them
 * before approval rather than signing a rounded order.
 */
export function orderRawEncodable(
  priceRaw: bigint,
  amountRaw: bigint,
  tokenDecimals: number,
  quoteTokenId: string,
): boolean {
  if (priceRaw <= 0n || amountRaw <= 0n) return false;
  if (priceRaw > MAX_SIGNED_INTEGER || amountRaw > MAX_SIGNED_INTEGER) return false;
  const total = orderRawTotal(priceRaw, amountRaw, tokenDecimals, quoteTokenId);
  return total >= 1n && total <= MAX_SIGNED_INTEGER;
}

/**
 * Format a raw smallest-unit amount like Java
 * `MonetaryFormat.FIAT.format(value, decimals)`: exact BigInt math, no
 * floating point, trailing zeros trimmed, "0" for zero.
 */
export function formatTokenAmount(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const divisor = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac === 0n ? '' : frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${fracStr ? '.' + fracStr : ''}`;
}

/**
 * Inverse of {@link formatTokenAmount} for an exact BigInt round-trip:
 * "3999999.99463" at 8 decimals → 3999999994630n. `BigInt()` on the display
 * string alone throws on the fraction, so the scale has to come from `decimals`.
 */
export function parseTokenAmount(display: string, decimals: number): bigint {
  const d = Math.max(0, decimals);
  const text = (display ?? '0').trim();
  const neg = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const tail = frac.slice(0, d).padEnd(d, '0');
  const magnitude = BigInt(whole || '0') * 10n ** BigInt(d) + (tail ? BigInt(tail) : 0n);
  return neg ? -magnitude : magnitude;
}

/**
 * Short display form of a long token id (PQ-pubkey token ids are KBs long):
 * keeps the identifying head and tail, mirroring the profile identity rows in
 * the dai feeds app. Copy controls keep the full value.
 */
export function shortTokenId(tokenid: string): string {
  return tokenid.length > 28 ? `${tokenid.slice(0, 14)}…${tokenid.slice(-6)}` : tokenid;
}
