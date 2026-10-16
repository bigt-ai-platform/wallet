/**
 * Capacitor-backed storage for the web build.
 *
 * In the standalone Android app (Capacitor), `Platform.OS === "web"`, so the
 * storage abstraction otherwise keeps values in the WebView's localStorage.
 * This module *used to* route every value into Android EncryptedSharedPreferences
 * (Keystore) via `capacitor-secure-storage-plugin`.
 *
 * That plugin is RSA-2048 — one private-key op per 245-byte block — so keeping
 * the wallet's ~46 KB encrypted wallet file there cost ~135 RSA ops on every
 * cold start, all before the app could render (a multi-second blank frame; see
 * android.md § Boot steps). As `../dai` learned with its chat replica, large
 * non-secret data does not belong in the RSA plugin. The wallet's only secret is
 * already scrypt-encrypted before it is stored, so it is not Keystore key
 * material either: everything lives in plain localStorage, and the RSA plugin is
 * used only for genuine key material (`isSecureKey` — currently nothing).
 *
 * Existing installs hold their values in the plugin; `initSecureStorage()`
 * drains them back to localStorage once, then the plugin stays empty. On a plain
 * browser this is a pass-through (no plugin, `native` stays false).
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

/** Boot milestones reported to the startup screen (`BootScreen`), kept as data
 *  (not i18n keys) so this module stays UI-free — mirrors `../dai`. */
export type BootPhase = "platform" | "storage" | "ready";
export type BootReporter = (phase: BootPhase, detail?: string) => void;

/**
 * Keys that must stay in the RSA Keystore plugin. The wallet holds no separate
 * key material — its only secret is the scrypt-encrypted wallet file, which is
 * self-protecting — so nothing qualifies today. The plugin is retained for
 * legacy draining and for future key material (e.g. a device pairing secret).
 */
const SECURE_PREFIXES: string[] = [];

function isSecureKey(k: string): boolean {
  return SECURE_PREFIXES.some((p) => k === p || k.startsWith(p));
}

const mem = new Map<string, string>();
let plugin: Plugin | null = null;
let native = false;
let ready = false;

/** True once storage is prepared (no-op/true on a plain browser). */
export function secureStorageReady(): boolean {
  return ready;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function lsGet(key: string): string | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time: move every legacy Keystore entry that is not key material back to
 * localStorage, so an existing install keeps its wallet/settings and stops
 * paying the per-block RSA cost on later boots. Only removes a plugin entry once
 * its value is safely in localStorage (or, failing that, in the session cache).
 */
async function drainLegacyKeystore(p: Plugin): Promise<number> {
  let keys: string[];
  try {
    keys = (await p.keys()).value ?? [];
  } catch {
    return 0;
  }
  const legacy = keys.filter((k) => !isSecureKey(k));
  let moved = 0;
  await Promise.all(
    legacy.map(async (k) => {
      try {
        const r = await p.get({ key: k });
        if (r.value == null) {
          await p.remove({ key: k }).catch(() => {});
          return;
        }
        // Serve this session from memory even before/if the localStorage write
        // fails, so a transient failure never looks like a lost wallet.
        mem.set(k, r.value);
        if (lsGet(k) === undefined) {
          if (!lsSet(k, r.value)) return; // keep it in the plugin, retry next launch
          moved++;
        }
        await p.remove({ key: k }).catch(() => {});
      } catch {
        /* unreadable this launch — leave the entry for the next one */
      }
    }),
  );
  return moved;
}

/** Load genuine key material into the sync cache (none today). */
async function preloadSecureKeys(p: Plugin): Promise<number> {
  let keys: string[];
  try {
    keys = (await p.keys()).value ?? [];
  } catch {
    return 0;
  }
  let loaded = 0;
  await Promise.all(
    keys
      .filter((k) => isSecureKey(k) && !mem.has(k))
      .map(async (k) => {
        try {
          const r = await p.get({ key: k });
          if (r.value != null) {
            mem.set(k, r.value);
            loaded++;
          }
        } catch {
          /* unreadable entry — treated as absent */
        }
      }),
  );
  return loaded;
}

/** Prepare storage, reporting each boot step to `onPhase`.
 *
 *  Steps: `platform` (detect the Capacitor shell) → `storage` (bring the plugin
 *  up, drain legacy entries, preload key material) → `ready`. The steps drive
 *  the branded boot screen so a slow start shows progress instead of a blank
 *  frame. */
export async function initSecureStorage(onPhase?: BootReporter): Promise<void> {
  if (ready) {
    onPhase?.("ready");
    return;
  }
  const t0 = now();
  onPhase?.("platform");
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  native = !!cap?.isNativePlatform?.();
  if (!native) {
    ready = true;
    onPhase?.("ready", "web");
    return;
  }
  onPhase?.("storage");
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
    onPhase?.("ready", "no-plugin");
    return;
  }
  const moved = await drainLegacyKeystore(plugin);
  const loaded = await preloadSecureKeys(plugin);
  ready = true;
  onPhase?.(
    "ready",
    `${loaded} key(s), ${moved} migrated in ${Math.round(now() - t0)}ms`,
  );
}

/** Wrap the web KV: key material in the Keystore, everything else in the
 *  fallback (localStorage), and a browser is a pure pass-through. */
export function secureWebKV(fallback: KV): KV {
  return {
    get: (k) => {
      if (native && mem.has(k)) return mem.get(k);
      return fallback.get(k);
    },
    set: (k, v) => {
      if (native && isSecureKey(k)) {
        mem.set(k, v);
        fallback.delete(k); // never leave plaintext behind
        void plugin?.set({ key: k, value: v }).catch(() => {});
        return;
      }
      if (native) mem.set(k, v);
      fallback.set(k, v);
    },
    delete: (k) => {
      mem.delete(k);
      fallback.delete(k);
      if (native && isSecureKey(k)) void plugin?.remove({ key: k }).catch(() => {});
    },
  };
}
