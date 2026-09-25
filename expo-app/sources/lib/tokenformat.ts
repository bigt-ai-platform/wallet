/**
 * Per-token amount formatting, mirroring the Java reference:
 *
 * - Token.decimals default 0 (net.bigtangle.core.Token), the base token "bc"
 *   (BIG) uses NetworkParameters.BIGTANGLE_DECIMAL = 6.
 * - Amounts are formatted the way Java's
 *   `MonetaryFormat.FIAT.format(value, token.getDecimals())` does
 *   (shift 0, minDecimals 0 → trailing zeros trimmed).
 */
import { NetworkParameters } from 'bigtangle-ts';

/** Decimals of the base token "bc" (BIG). */
export const BC_DECIMALS = NetworkParameters.BIGTANGLE_DECIMAL;

/**
 * Effective decimals for a token: the token metadata value when present,
 * else BIGTANGLE_DECIMAL for "bc", else 0 (Java Token default).
 */
export function decimalsFor(tokenid: string, tokenDecimals?: number | null): number {
  if (typeof tokenDecimals === 'number' && tokenDecimals >= 0) {
    return tokenDecimals;
  }
  return tokenid === 'bc' ? BC_DECIMALS : 0;
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
