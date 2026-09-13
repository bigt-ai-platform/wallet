/**
 * Locale-aware amount formatting shared by the balance screens.
 * Grouping/decimal separators follow the active locale, amounts are exact
 * BigInt math like Java's MonetaryFormat.FIAT (trailing zeros trimmed).
 */

export function toBigInt(v: any): bigint {
  try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

const separatorCache = new Map<string, { thousand: string; decimal: string }>();

export function localeSeparators(locale: string): { thousand: string; decimal: string } {
  const hit = separatorCache.get(locale);
  if (hit) return hit;
  let thousand = ',';
  let decimal = '.';
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
    for (const p of parts) {
      if (p.type === 'group') thousand = p.value;
      else if (p.type === 'decimal') decimal = p.value;
    }
  } catch { /* fall back to en separators */ }
  const sep = { thousand, decimal };
  separatorCache.set(locale, sep);
  return sep;
}

export function formatValue(v: bigint, decimals: number, locale: string): string {
  const { thousand, decimal } = localeSeparators(locale);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const divisor = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / divisor;
  const frac = abs % divisor;
  // Group the whole part with the locale's thousands separator.
  const digits = whole.toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, thousand);
  if (frac === 0n) return `${neg ? '-' : ''}${grouped}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${grouped}${decimal}${fracStr}`;
}
