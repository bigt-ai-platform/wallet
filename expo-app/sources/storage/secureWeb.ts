/**
 * Capacitor-backed secure storage for the web build.
 *
 * In the standalone Android app (Capacitor), `Platform.OS === "web"`, so the
 * storage abstraction would otherwise keep everything in the WebView's
 * localStorage. This routes those values into Android EncryptedSharedPreferences
 * (Keystore-backed) via `capacitor-secure-storage-plugin`.
 *
 * The plugin API is async but the app's KV is sync, so we keep an in-memory
 * cache: `initSecureStorage()` preloads every plugin key before the app reads
 * its wallet, reads are served synchronously from the cache, and writes/deletes
 * update the cache and write through asynchronously. Any value still in
 * localStorage is lazily migrated on first read. On a plain browser this is a
 * pass-through (no plugin, `native` stays false).
 */

interface KV {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

interface Plugin {
  get(o: { key: string }): Promise<{ value: string }>;
  set(o: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(o: { key: string }): Promise<{ value: boolean }>;
  keys(): Promise<{ value: string[] }>;
}

const mem = new Map<string, string>();
let plugin: Plugin | null = null;
let native = false;
let ready = false;

/** True once the Keystore cache is loaded (no-op/true on a plain browser). */
export function secureStorageReady(): boolean {
  return ready;
}

export async function initSecureStorage(): Promise<void> {
  if (ready) return;
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  native = !!cap?.isNativePlatform?.();
  if (!native) {
    ready = true;
    return;
  }
  try {
    const mod = (await import("capacitor-secure-storage-plugin")) as unknown as {
      SecureStoragePlugin: Plugin;
    };
    plugin = mod.SecureStoragePlugin;
  } catch {
    plugin = null;
  }
  if (!plugin) {
    native = false;
    ready = true;
    return;
  }
  try {
    const keys = (await plugin.keys()).value ?? [];
    for (const k of keys) {
      const r = await plugin.get({ key: k });
      if (r.value != null) mem.set(k, r.value);
    }
  } catch {
    /* keys() unavailable — reads fall back to lazy migration below */
  }
  ready = true;
}

/** Wrap the web KV: Keystore-backed in the app, pass-through in a browser. */
export function secureWebKV(fallback: KV): KV {
  return {
    get: (k) => {
      if (!native) return fallback.get(k);
      if (mem.has(k)) return mem.get(k);
      // Lazy-migrate a leftover plaintext value on first read.
      const v = fallback.get(k);
      if (v !== undefined) {
        mem.set(k, v);
        void plugin?.set({ key: k, value: v }).catch(() => {});
        fallback.delete(k);
      }
      return v;
    },
    set: (k, v) => {
      if (!native) return fallback.set(k, v);
      mem.set(k, v);
      fallback.delete(k); // never leave plaintext behind
      void plugin?.set({ key: k, value: v }).catch(() => {});
    },
    delete: (k) => {
      if (!native) return fallback.delete(k);
      mem.delete(k);
      fallback.delete(k);
      void plugin?.remove({ key: k }).catch(() => {});
    },
  };
}
