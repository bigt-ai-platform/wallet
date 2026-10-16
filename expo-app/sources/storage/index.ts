/**
 * Simple storage abstraction.
 *
 * Native: MMKV. Web/SSR: localStorage (in-memory when unavailable), with the
 * Android Keystore plugin reserved for key material (see `./secureWeb`) — this
 * module is imported by app-wide code (e.g. i18n language persistence), so it
 * must never crash the web bundle. MMKV is only constructed on native, inside
 * try/catch.
 */

import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import {
  secureWebKV,
  initSecureStorage as initSecureWebStorage,
  type BootReporter,
} from './secureWeb';

export type { BootPhase, BootReporter } from './secureWeb';

const MMKV_KEY_NAME = 'device.mmkv.key';
let nativeEncryptionKey: string | null = null;

/** 32 random bytes as hex, or null when no CSPRNG is available. */
function randomKeyHex(): string | null {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (!c?.getRandomValues) return null;
  const bytes = new Uint8Array(32);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Load the MMKV encryption key (native only): generated once with a CSPRNG and kept in the OS
 * keychain via expo-secure-store. On web this is a no-op (already Keystore-backed), and when no
 * CSPRNG is available the store falls back to the unencrypted instance rather than crashing.
 */
async function initNativeEncryptionKey(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const SecureStore = await import('expo-secure-store');
    let key = await SecureStore.getItemAsync(MMKV_KEY_NAME);
    if (!key) {
      key = randomKeyHex();
      if (!key) return;
      await SecureStore.setItemAsync(MMKV_KEY_NAME, key);
    }
    nativeEncryptionKey = key;
  } catch {
    nativeEncryptionKey = null;
  }
}

/** Prepare storage (web: drain legacy Keystore → localStorage + load key
 *  material; native: MMKV key). Call once at startup. `onPhase` reports each
 *  boot step for the startup screen. */
export async function initSecureStorage(onPhase?: BootReporter): Promise<void> {
  await initSecureWebStorage(onPhase);
  await initNativeEncryptionKey();
}

interface KV {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
  };
}

function webKV(): KV {
  try {
    if (typeof localStorage === 'undefined') return memoryKV();
    return {
      get: (k) => localStorage.getItem(k) ?? undefined,
      set: (k, v) => void localStorage.setItem(k, v),
      delete: (k) => void localStorage.removeItem(k),
    };
  } catch {
    return memoryKV();
  }
}

function wrapMMKV(storage: MMKV): KV {
  return {
    get: (k) => storage.getString(k),
    set: (k, v) => void storage.set(k, v),
    delete: (k) => void storage.delete(k),
  };
}

function nativeKV(): KV {
  try {
    if (nativeEncryptionKey) {
      try {
        // Encrypted instance — the paired bearer token is a full-device credential.
        return wrapMMKV(new MMKV({ id: 'device-secure', encryptionKey: nativeEncryptionKey }));
      } catch {
        /* key rejected (e.g. an existing plaintext instance) — fall back to unencrypted */
      }
    }
    return wrapMMKV(new MMKV());
  } catch {
    return webKV();
  }
}

let impl: KV | null = null;
function kv(): KV {
  // In the Capacitor-wrapped app this is Keystore-backed (see secureWeb.ts).
  if (!impl) impl = Platform.OS === 'web' ? secureWebKV(webKV()) : nativeKV();
  return impl;
}

export const device = {
  get(key: string[]): string | undefined {
    return kv().get(key.join('.'));
  },
  set(key: string[], value: string): void {
    kv().set(key.join('.'), value);
  },
  remove(key: string[]): void {
    kv().delete(key.join('.'));
  },
};
