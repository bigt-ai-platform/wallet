/**
 * Local (device-stored) withdrawal data: the saved-address book and the
 * withdrawal history. Pure list operations so they are unit-testable; the
 * storage wrapper lives in `services/withdrawLocal.ts`.
 */

export interface SavedAddress {
  /** Checksummed 0x address. */
  address: string;
  /** Optional user label ("Binance", "Alice"). */
  label?: string;
  addedAt: number;
}

export type WithdrawalStatus = 'pending' | 'success' | 'failed';

export interface WithdrawalRecord {
  hash: string;
  symbol: string;
  /** Display amount. */
  amount: string;
  to: string;
  network: string;
  at: number;
  status: WithdrawalStatus;
}

export const MAX_SAVED_ADDRESSES = 50;
export const MAX_WITHDRAWALS = 50;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds (or relabels) an address, newest first, deduplicated and capped. */
export function addSavedAddress(
  list: SavedAddress[],
  address: string,
  label?: string,
  now = Date.now()
): SavedAddress[] {
  const clean = label?.trim();
  const next: SavedAddress = {
    address,
    label: clean ? clean : undefined,
    addedAt: now,
  };
  return [next, ...list.filter((entry) => !same(entry.address, address))].slice(
    0,
    MAX_SAVED_ADDRESSES
  );
}

export function removeSavedAddress(list: SavedAddress[], address: string): SavedAddress[] {
  return list.filter((entry) => !same(entry.address, address));
}

export function hasSavedAddress(list: SavedAddress[], address: string): boolean {
  return list.some((entry) => same(entry.address, address));
}

/** Adds or replaces a withdrawal (by hash), newest first, capped. */
export function upsertWithdrawal(
  list: WithdrawalRecord[],
  record: WithdrawalRecord
): WithdrawalRecord[] {
  return [record, ...list.filter((entry) => entry.hash !== record.hash)].slice(
    0,
    MAX_WITHDRAWALS
  );
}

export function setWithdrawalStatus(
  list: WithdrawalRecord[],
  hash: string,
  status: WithdrawalStatus
): WithdrawalRecord[] {
  return list.map((entry) => (entry.hash === hash ? { ...entry, status } : entry));
}

export function pendingWithdrawals(list: WithdrawalRecord[]): WithdrawalRecord[] {
  return list.filter((entry) => entry.status === 'pending');
}

/** Defensive parse of persisted JSON; drops malformed rows. */
export function parseList<T>(
  raw: string | undefined,
  valid: (value: unknown) => value is T
): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

export function isSavedAddress(value: unknown): value is SavedAddress {
  const v = value as SavedAddress;
  return !!v && typeof v.address === 'string' && typeof v.addedAt === 'number';
}

export function isWithdrawalRecord(value: unknown): value is WithdrawalRecord {
  const v = value as WithdrawalRecord;
  return (
    !!v &&
    typeof v.hash === 'string' &&
    typeof v.symbol === 'string' &&
    typeof v.amount === 'string' &&
    typeof v.at === 'number' &&
    (v.status === 'pending' || v.status === 'success' || v.status === 'failed')
  );
}
