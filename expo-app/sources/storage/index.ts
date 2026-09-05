/**
 * Simple storage abstraction.
 *
 * Native: MMKV. Web/SSR fallback: localStorage (in-memory when unavailable) —
 * this module is imported by app-wide code (e.g. i18n language persistence),
 * so it must never crash the web bundle. MMKV is only constructed on native,
 * inside try/catch.
 */

import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

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

function nativeKV(): KV {
  try {
    const storage = new MMKV();
    return {
      get: (k) => storage.getString(k),
      set: (k, v) => void storage.set(k, v),
      delete: (k) => void storage.delete(k),
    };
  } catch {
    return webKV();
  }
}

let impl: KV | null = null;
function kv(): KV {
  if (!impl) impl = Platform.OS === 'web' ? webKV() : nativeKV();
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
