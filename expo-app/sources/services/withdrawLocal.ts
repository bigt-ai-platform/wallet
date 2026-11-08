/**
 * Device-backed saved withdrawal addresses and withdrawal history.
 *
 * Kept in the same KV store as the other wallet settings (`device`), so the
 * address book and the history survive app restarts (previously the withdraw
 * screen kept history in component state only).
 */

import { device } from '@/storage';
import { requireAddress } from '@/lib/eth/address';
import {
  addSavedAddress, isSavedAddress, isWithdrawalRecord, parseList,
  removeSavedAddress, setWithdrawalStatus as setStatusIn, upsertWithdrawal,
  type SavedAddress, type WithdrawalRecord, type WithdrawalStatus,
} from '@/lib/withdrawLocal';

const BOOK_KEY = ['eth', 'savedAddresses'];
const HISTORY_KEY = ['eth', 'withdrawals'];

export function listSavedAddresses(): SavedAddress[] {
  return parseList(device.get(BOOK_KEY), isSavedAddress);
}

/** Validates (EIP-55) and stores/re-labels an address. */
export function saveAddress(address: string, label?: string): SavedAddress[] {
  const checksummed = requireAddress(address);
  const next = addSavedAddress(listSavedAddresses(), checksummed, label);
  device.set(BOOK_KEY, JSON.stringify(next));
  return next;
}

export function deleteAddress(address: string): SavedAddress[] {
  const next = removeSavedAddress(listSavedAddresses(), address);
  device.set(BOOK_KEY, JSON.stringify(next));
  return next;
}

export function listWithdrawals(): WithdrawalRecord[] {
  return parseList(device.get(HISTORY_KEY), isWithdrawalRecord);
}

export function recordWithdrawal(record: WithdrawalRecord): WithdrawalRecord[] {
  const next = upsertWithdrawal(listWithdrawals(), record);
  device.set(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function setWithdrawalStatus(
  hash: string,
  status: WithdrawalStatus
): WithdrawalRecord[] {
  const next = setStatusIn(listWithdrawals(), hash, status);
  device.set(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function clearWithdrawals(): WithdrawalRecord[] {
  device.set(HISTORY_KEY, JSON.stringify([]));
  return [];
}
