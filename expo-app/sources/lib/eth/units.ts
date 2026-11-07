/**
 * Amount parsing/formatting for Ethereum assets: exact BigInt math, no floats.
 * Formatting reuses the wallet-wide locale-aware `formatValue`, so ETH amounts
 * render with the same separators as BIG amounts.
 */

import { formatValue } from '../amountformat';

/** Digits-only decimal string → smallest units; throws on invalid input. */
export function parseUnits(text: string, decimals: number): bigint {
  const value = text.trim().replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(value) || value === '' || value === '.') {
    throw new Error('Invalid amount');
  }
  const [whole = '0', frac = ''] = value.split('.');
  if (frac.length > decimals) throw new Error('Too many decimal places');
  const padded = frac.padEnd(decimals, '0');
  return BigInt(`${whole || '0'}${padded}` || '0');
}

export function isValidUnits(text: string, decimals: number): boolean {
  try {
    parseUnits(text, decimals);
    return true;
  } catch {
    return false;
  }
}

/** Smallest units → localized display string (trailing zeros trimmed). */
export function formatUnits(raw: bigint, decimals: number, locale = 'en'): string {
  return formatValue(raw, decimals, locale);
}

/** Shorten an address for lists: 0x1234…abcd. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
