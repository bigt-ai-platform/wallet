/**
 * USDT deposit bridge (Ethereum USDT -> the USDT token created on the L1 order
 * chain).
 *
 * This is the client half of the model `../vmproject` implements server-side
 * (`DepositBatchAction` + `CryptoTokenlist.BinanceETHPayADDRESS`): the user
 * sends USDT on Ethereum to an **issuer-controlled address**, the issuer then
 * pays the same amount of the L1-order USDT token from its own L1 wallet to the
 * user's L1 address.
 *
 * Two address models are supported, matching the exchange practice:
 *  - `apiUrl` set: `GET <api>/deposit-address?account=<l1>` returns the user's
 *    **own** deposit address (HD-derived per user, like Binance) — crediting is
 *    then matched by address; `memo` is only used by shared-address chains.
 *  - no API: a single configured `issuerAddress` is shown (the vmproject
 *    model), and the issuer tracks deposits by its own balance delta.
 *
 * Status: `GET <api>/deposits?account=<l1>` ->
 *   `{ items: [{ hash, amount, status: 'pending'|'credited'|'failed' }] }`.
 */

import { device } from '@/storage';

const KEY = ['eth', 'bridge'];

export interface BridgeSettings {
  /** Issuer status/address API (no trailing slash needed). */
  apiUrl: string;
  /** Static issuer address used when no API is configured. */
  issuerAddress: string;
  /** Minimum deposit in whole USDT (display units). */
  minUsdt: string;
}

export interface DepositAddress {
  address: string;
  /** Present only when the issuer uses a shared address + memo. */
  memo?: string;
  /** Where the address came from, for the UI hint. */
  source: 'api' | 'static';
}

export interface BridgeDeposit {
  hash: string;
  /** Display units, as returned by the issuer (fallback: raw wei string). */
  amount: string;
  status: 'pending' | 'credited' | 'failed';
  creditedAt?: string;
}

export function getBridgeSettings(): BridgeSettings {
  const raw = device.get(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BridgeSettings>;
      return {
        apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl.trim() : '',
        issuerAddress: typeof parsed.issuerAddress === 'string' ? parsed.issuerAddress.trim() : '',
        minUsdt: typeof parsed.minUsdt === 'string' ? parsed.minUsdt.trim() : '',
      };
    } catch {
      /* fall through */
    }
  }
  return { apiUrl: '', issuerAddress: '', minUsdt: '' };
}

export function setBridgeSettings(patch: Partial<BridgeSettings>): void {
  device.set(KEY, JSON.stringify({ ...getBridgeSettings(), ...patch }));
}

export function isBridgeConfigured(): boolean {
  const s = getBridgeSettings();
  return !!(s.apiUrl || s.issuerAddress);
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Deposit address for this account: the issuer API's per-user address when it
 * is configured, else the static issuer address.
 */
export async function getDepositAddress(account: string): Promise<DepositAddress | null> {
  const s = getBridgeSettings();
  if (s.apiUrl) {
    const res = await fetch(
      `${trimBase(s.apiUrl)}/deposit-address?account=${encodeURIComponent(account)}`
    );
    if (!res.ok) throw new Error(`Deposit address API HTTP ${res.status}`);
    const body = (await res.json()) as { address?: string; memo?: string };
    if (body.address) {
      return { address: body.address, memo: body.memo || undefined, source: 'api' };
    }
  }
  return s.issuerAddress ? { address: s.issuerAddress, source: 'static' } : null;
}

/** Issuer-reported deposit status; an unconfigured API simply returns none. */
export async function getBridgeDeposits(account: string): Promise<BridgeDeposit[]> {
  const s = getBridgeSettings();
  if (!s.apiUrl) return [];
  const res = await fetch(`${trimBase(s.apiUrl)}/deposits?account=${encodeURIComponent(account)}`);
  if (!res.ok) throw new Error(`Deposit status API HTTP ${res.status}`);
  const body = (await res.json()) as { items?: BridgeDeposit[] };
  return (body.items ?? []).filter(
    (d): d is BridgeDeposit =>
      !!d && typeof d.hash === 'string' &&
      (d.status === 'pending' || d.status === 'credited' || d.status === 'failed')
  );
}
