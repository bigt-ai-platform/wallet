import { describe, expect, it, vi } from 'vitest';

/**
 * The Capacitor storage adapter used to put *every* value in the RSA-2048
 * Keystore plugin; the wallet's ~46 KB encrypted file cost ~135 RSA ops on each
 * cold start. `initSecureStorage()` must now drain legacy plugin entries back to
 * localStorage (once) and route all non-key-material reads/writes there, so the
 * RSA plugin only ever holds `isSecureKey()` values.
 */
const { store, removed, ls } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  removed: [] as string[],
  ls: new Map<string, string>(),
}));

vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
      return { value: true };
    },
    remove: async ({ key }: { key: string }) => {
      store.delete(key);
      removed.push(key);
      return { value: true };
    },
    keys: async () => ({ value: [...store.keys()] }),
  },
}));

(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, v),
  removeItem: (k: string) => void ls.delete(k),
};
(globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };

import { initSecureStorage, secureWebKV } from '../secureWeb';

describe('secureWeb legacy Keystore drain', () => {
  it('moves legacy entries to localStorage and serves non-secret keys there', async () => {
    store.set('device.walletEncryptedContent', 'CIPHERTEXT');
    store.set('settings.language', 'de');

    const phases: string[] = [];
    await initSecureStorage((p) => phases.push(p));
    expect(phases).toEqual(['platform', 'storage', 'ready']);

    // Drained out of the RSA plugin...
    expect(store.has('device.walletEncryptedContent')).toBe(false);
    expect(removed).toContain('device.walletEncryptedContent');
    // ...and preserved byte-for-byte in localStorage.
    expect(ls.get('device.walletEncryptedContent')).toBe('CIPHERTEXT');
    expect(ls.get('settings.language')).toBe('de');

    const fallback = {
      get: (k: string) => ls.get(k),
      set: (k: string, v: string) => void ls.set(k, v),
      delete: (k: string) => void ls.delete(k),
    };
    const kv = secureWebKV(fallback);
    expect(kv.get('device.walletEncryptedContent')).toBe('CIPHERTEXT');

    // New non-secret writes go straight to localStorage, never the plugin.
    kv.set('settings.language', 'fr');
    expect(ls.get('settings.language')).toBe('fr');
    expect(store.has('settings.language')).toBe(false);
  });
});
