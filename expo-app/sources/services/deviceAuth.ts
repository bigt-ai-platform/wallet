/**
 * Device-unlock confirmation bridge (Capacitor/Android only).
 *
 * Important transactions (pay / buy / sell) are signed in JS with the wallet key
 * that is already in memory, so an unlocked-and-attended-by-someone-else phone
 * could move funds with no further check. This drives the native `DeviceAuth`
 * plugin, which shows the OS unlock (fingerprint/face or the device PIN/pattern)
 * before the transaction is signed.
 *
 * In a plain browser or on iOS the plugin is absent, so `confirmWithDeviceUnlock`
 * reports `unavailable` and the caller falls back to the wallet password.
 */
import { registerPlugin } from '@capacitor/core';

export interface DeviceAuthPlugin {
  isAvailable(): Promise<{ available: boolean; code?: number }>;
  confirm(opts: { title?: string; subtitle?: string; reason?: string }): Promise<{
    ok: boolean;
    code?: number;
    error?: string;
  }>;
}

/** `unavailable` → no native plugin or the OS has no credential set (fall back
 *  to the wallet password); `denied` → the user cancelled / failed the prompt. */
export type DeviceUnlock = 'ok' | 'denied' | 'unavailable';

function isNativeAndroid(): boolean {
  const cap = (globalThis as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  return !!cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android';
}

let cached: DeviceAuthPlugin | null | undefined;

/**
 * Registered only on Android; null otherwise. Synchronous on purpose:
 * `registerPlugin` returns a Proxy and awaiting it probes `.then`, which
 * Capacitor rejects (see updater.ts) — never `await` the returned value.
 */
function plugin(): DeviceAuthPlugin | null {
  if (cached !== undefined) return cached;
  if (!isNativeAndroid()) {
    cached = null;
    return null;
  }
  try {
    cached = registerPlugin<DeviceAuthPlugin>('DeviceAuth');
  } catch {
    cached = null;
  }
  return cached;
}

/** True inside the Android app where the `DeviceAuth` plugin exists. */
export function isDeviceUnlockSupported(): boolean {
  return plugin() !== null;
}

/** Show the OS unlock prompt. Returns `unavailable` when it cannot be used. */
export async function confirmWithDeviceUnlock(
  opts: { title?: string; subtitle?: string; reason?: string } = {},
): Promise<DeviceUnlock> {
  const p = plugin();
  if (!p) return 'unavailable';
  try {
    const avail = await p.isAvailable();
    if (!avail?.available) return 'unavailable';
    const res = await p.confirm(opts);
    return res?.ok ? 'ok' : 'denied';
  } catch {
    return 'unavailable';
  }
}
