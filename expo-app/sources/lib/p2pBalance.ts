import type { WalletAccountItem } from '@/types/api';

/**
 * Advisory availability check for the P2P sell form.
 *
 * Nothing verifies on chain that a seller holds the token at listing time —
 * funds are proven only at `escrow_lock` — so this is the wallet's early
 * warning. It is deliberately **advisory**: when the balance cannot be
 * resolved it never blocks (see `exceedsBalance`).
 */

/**
 * The balance row for a listing's token: by id when the seller picked one from
 * the token list, else by an unambiguous name match. A name that matches zero
 * or several rows resolves to null (never guess).
 */
export function findBalance(
  items: readonly WalletAccountItem[],
  opts: { tokenId?: string | null; tokenName?: string },
): WalletAccountItem | null {
  const id = opts.tokenId?.trim();
  if (id) {
    const byId = items.find((b) => b.tokenid === id);
    if (byId) return byId;
  }
  const name = opts.tokenName?.trim().toLowerCase();
  if (!name) return null;
  const matches = items.filter((b) => (b.tokenname || '').toLowerCase() === name);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Implied per-unit price (`total / give`), display-only: the listing stores the
 * **total** fiat (`wantAmount`), so this is shown as a convenience next to it.
 * Returns null when the inputs are not usable numbers.
 */
export function perUnitPrice(total: string, give: string, decimals = 8): string | null {
  const t = Number(String(total ?? '').trim());
  const g = Number(String(give ?? '').trim());
  if (!Number.isFinite(t) || !Number.isFinite(g) || g <= 0 || t <= 0) return null;
  const v = t / g;
  if (!Number.isFinite(v) || v <= 0) return null;
  const fixed = v.toFixed(Math.max(0, decimals));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** `price × amount` as a trimmed decimal string (Binance's Total from a unit
 *  price + crypto amount), or null when the inputs are unusable. Display-grade. */
export function totalAmount(price: string, amount: string, decimals = 12): string | null {
  const p = Number(String(price ?? '').trim());
  const a = Number(String(amount ?? '').trim());
  if (!Number.isFinite(p) || !Number.isFinite(a) || p <= 0 || a <= 0) return null;
  const v = p * a;
  if (!Number.isFinite(v) || v <= 0) return null;
  const fixed = v.toFixed(Math.max(0, decimals));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export function amountToRaw(amount: string, decimals: number): bigint | null {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = Math.max(0, Math.floor(decimals) || 0);
  const [whole, frac = ''] = s.split('.');
  const scaled = (frac + '0'.repeat(d)).slice(0, d);
  return BigInt(whole || '0') * 10n ** BigInt(d) + BigInt(scaled || '0');
}

function itemRaw(item: WalletAccountItem): bigint | null {
  if (item.raw !== undefined && item.raw !== '') {
    try {
      return BigInt(item.raw);
    } catch {
      return null;
    }
  }
  return amountToRaw(item.balance, item.decimals);
}

/**
 * True only when we positively know the balance and `amount` strictly exceeds
 * it (exact, at the token's decimals). Unknown balance → false: the check is a
 * guard rail, never a reason to block a legitimate listing.
 */
export function exceedsBalance(amount: string, item: WalletAccountItem | null): boolean {
  if (!item) return false;
  const raw = itemRaw(item);
  if (raw === null) return false;
  const amt = amountToRaw(amount, item.decimals);
  if (amt === null) return false;
  return amt > raw;
}
