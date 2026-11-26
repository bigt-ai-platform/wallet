/**
 * Pending L1 funding for USDT redemptions.
 *
 * A redemption needs a real L1 return before the issuer can release. If the
 * request is rejected or the app reloads after that transfer, sending again
 * would strand a second payment; pending funding is therefore persisted and
 * reused for the same account/amount. The memo binds the return to the account
 * that signs the intent (the issuer recomputes it), so it must match exactly.
 *
 * Records are kept per outpoint (not as one global slot) so starting another
 * redemption cannot overwrite the first one.
 */

import { device } from '@/storage';

const KEY = ['redeem', 'pendingFunding'];
const MAX_RECORDS = 50;

export interface PendingRedemptionFunding {
  txHash: string;
  account: string;
  assetId: string;
  amountRaw: string;
  memo: string;
  /** The chain network the payment was made on (`Test` / `Mainnet`). */
  network: 'Test' | 'Mainnet';
  at: number;
}

/**
 * Byte-for-byte with `services/asset-issuer/src/l1.ts` (`redemptionMemo`).
 * Changing it is a protocol change: both sides must ship together.
 */
export function redemptionMemo(assetId: string, amountRaw: string, account: string): string {
  return `wallet-redeem:v1:${assetId.trim().toLowerCase()}:${amountRaw}:${account.trim()}`;
}

function isRecord(value: unknown): value is PendingRedemptionFunding {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PendingRedemptionFunding>;
  return typeof v.txHash === 'string' && !!v.txHash
    && typeof v.account === 'string' && !!v.account
    && typeof v.assetId === 'string' && !!v.assetId
    && typeof v.amountRaw === 'string' && /^\d+$/.test(v.amountRaw)
    && typeof v.memo === 'string'
    && (v.network === 'Test' || v.network === 'Mainnet');
}

export function loadPendingRedemptionFundings(): PendingRedemptionFunding[] {
  const raw = device.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Accept a legacy single record as well as the current list.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter(isRecord)
      .map((record) => ({
        ...record,
        at: typeof record.at === 'number' ? record.at : 0,
      }))
      .slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

/** Insert or replace the record for this outpoint. Distinct returns are kept
 *  (the user can pick one to resume); only the same outpoint is replaced. */
export function savePendingRedemptionFunding(
  value: Omit<PendingRedemptionFunding, 'at'>,
): PendingRedemptionFunding {
  const record: PendingRedemptionFunding = { ...value, at: Date.now() };
  const existing = loadPendingRedemptionFundings().filter((entry) => entry.txHash !== record.txHash);
  device.set(KEY, JSON.stringify([...existing, record].slice(-MAX_RECORDS)));
  return record;
}

/** Clear one outpoint (default: everything). */
export function clearPendingRedemptionFunding(txHash?: string): void {
  if (!txHash) {
    device.remove(KEY);
    return;
  }
  const remaining = loadPendingRedemptionFundings().filter((entry) => entry.txHash !== txHash);
  if (remaining.length === 0) device.remove(KEY);
  else device.set(KEY, JSON.stringify(remaining));
}

/** The saved return that funds exactly this account/asset/amount/network. */
export function matchingPendingRedemptionFunding(
  account: string,
  assetId: string,
  amountRaw: string,
  network: 'Test' | 'Mainnet',
): PendingRedemptionFunding | null {
  const expectedMemo = redemptionMemo(assetId, amountRaw, account);
  return loadPendingRedemptionFundings().find((entry) => (
    entry.account === account
    && entry.network === network
    && entry.assetId.toLowerCase() === assetId.toLowerCase()
    && entry.amountRaw === amountRaw
    && entry.memo === expectedMemo
  )) ?? null;
}
