/**
 * "Remember this device" for the wallet unlock — the wallet counterpart of
 * `../dai`'s remembered-device unlock (`apps/web/src/lib/wallet.ts`), with the
 * OS credential as the gate.
 *
 * After a successful password unlock the password is kept in the Keystore-backed
 * store (see `storage/secureWeb.ts` → `SECURE_PREFIXES`) so the lock screen can
 * offer the device credential (fingerprint / face / PIN) instead of asking for
 * the wallet password every time. The stored secret is only read *after*
 * `confirmWithDeviceUnlock()` succeeded, and it is removed with the wallet or
 * when the user turns the option off.
 *
 * Native (Capacitor/Android) only: on the web the password is never persisted,
 * so the browser wallet keeps its normal unlock.
 */

import { device } from '@/storage';
import { isCapacitorNative } from '@/lib/platform';

const KEY = ['wallet', 'deviceUnlock'];

/** Device-local pref; on unless the user turned it off. */
const PREF = ['settings', 'unlockWithDevice'];

export function getRememberDeviceUnlock(): boolean {
  return device.get(PREF) !== 'false';
}

export function setRememberDeviceUnlock(enabled: boolean): void {
  device.set(PREF, enabled ? 'true' : 'false');
  if (!enabled) forgetWalletUnlock();
}

/** Persist the wallet password for credential-based unlock (native only). */
export function rememberWalletUnlock(password: string): void {
  if (!isCapacitorNative() || !getRememberDeviceUnlock() || !password) return;
  device.set(KEY, password);
}

/** The remembered password, or null. Never call this before the OS prompt. */
export function getRememberedWalletUnlock(): string | null {
  if (!isCapacitorNative()) return null;
  return device.get(KEY) ?? null;
}

export function hasRememberedWalletUnlock(): boolean {
  return getRememberedWalletUnlock() !== null;
}

export function forgetWalletUnlock(): void {
  device.remove(KEY);
}
