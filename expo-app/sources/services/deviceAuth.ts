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

/**
 * True while an OS unlock prompt is up.
 *
 * On several OEM builds the device-credential (PIN/pattern) step of
 * `BiometricPrompt` is a separate system activity, so the WebView sees
 * `AppState === 'background'` for the whole prompt. The wallet must not treat
 * that as "the user left the app" and wipe itself mid transaction — the create
 * flow would come back to the unlock screen after the user authenticated.
 */
let promptsInFlight = 0;
export function isDeviceUnlockPromptActive(): boolean {
  return promptsInFlight > 0;
}

const settledListeners = new Set<() => void>();

/** Subscribe to "the prompt finished"; returns an unsubscribe function. */
export function onDeviceUnlockSettled(fn: () => void): () => void {
  settledListeners.add(fn);
  return () => { settledListeners.delete(fn); };
}

/** Show the OS unlock prompt. Returns `unavailable` when it cannot be used. */
export async function confirmWithDeviceUnlock(
  opts: { title?: string; subtitle?: string; reason?: string } = {},
): Promise<DeviceUnlock> {
  const p = plugin();
  if (!p) return 'unavailable';
  try {
    const avail = await withTimeout(p.isAvailable(), PROBE_TIMEOUT_MS, null);
    if (!avail?.available) return 'unavailable';
    // The native prompt resolves from its AuthenticationCallback. If the
    // Activity is recreated while it is up (rotation, a system dialog taking
    // over) that callback can be lost and the call would pend forever, leaving
    // the caller stuck on "Unlocking…". Treat a lost prompt as unavailable.
    promptsInFlight += 1;
    let res: Awaited<ReturnType<DeviceAuthPlugin['confirm']>> | null;
    try {
      res = await withTimeout(p.confirm(opts), PROMPT_TIMEOUT_MS, null);
    } finally {
      promptsInFlight -= 1;
      if (promptsInFlight === 0) {
        for (const fn of settledListeners) {
          try { fn(); } catch { /* a listener must never break settlement */ }
        }
      }
    }
    if (res == null) return 'unavailable';
    return res.ok ? 'ok' : 'denied';
  } catch {
    return 'unavailable';
  }
}

const PROBE_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 90_000;

/** Await `p`, but never longer than `ms` (resolves `fallback` instead). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
