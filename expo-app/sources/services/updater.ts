/**
 * OTA updater bridge (Capacitor/Android only).
 *
 * The web layer resolves the region release manifest, compares its versionCode
 * against the installed build, and drives the native `Updater` plugin:
 * `getVersion` reads the installed versionCode, `install` downloads + verifies
 * sha256 + installs the signed APK via PackageInstaller. In a plain browser
 * this is a no-op (the Android APK is the only installable artifact).
 */
import { registerPlugin } from '@capacitor/core';
import { Alert } from 'react-native';
import { OTA_BASE, OTA_CHANNEL, OTA_TYPE } from '@/constants/app';
import i18n from '@/lib/i18n';
import {
  fetchManifest,
  manifestUrl,
  updateInfo,
  type InstalledVersion,
  type OtaManifest,
  type UpdateInfo,
} from '@/lib/ota';

export type { InstalledVersion, OtaManifest, UpdateInfo };

export interface UpdaterPlugin {
  getVersion(): Promise<InstalledVersion>;
  install(opts: { url: string; sha256?: string }): Promise<{ success: boolean; status: number }>;
}

function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

let cached: UpdaterPlugin | null | undefined;

/**
 * Registered only on the native platform; null otherwise.
 *
 * Deliberately synchronous: `registerPlugin` returns a Proxy, and awaiting it
 * probes `.then`, which Capacitor rejects with `"<name>.then()" is not
 * implemented` — the promise never settles and the whole update check dies
 * silently. Callers must take the returned value as-is, never `await` it.
 */
function plugin(): UpdaterPlugin | null {
  if (cached !== undefined) return cached;
  if (!isNative()) {
    cached = null;
    return null;
  }
  try {
    cached = registerPlugin<UpdaterPlugin>('Updater');
  } catch {
    cached = null;
  }
  return cached;
}

/** Current installed version, or null off-device. */
export async function currentVersion(): Promise<InstalledVersion | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return await p.getVersion();
  } catch {
    return null;
  }
}

/**
 * Check the release manifest for a newer build. Returns null when the check
 * cannot be performed (off-device, unknown installed version, or the manifest
 * is unreachable/malformed).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const version = await currentVersion();
  if (!version) return null;
  const manifest = await fetchManifest(manifestUrl(OTA_BASE, OTA_CHANNEL, OTA_TYPE));
  if (!manifest) return null;
  return updateInfo(manifest, version.versionCode);
}

/**
 * Ask the user before a non-mandatory OTA install. Resolves false on dismiss.
 *
 * react-native-web ships `Alert.alert` as a no-op, and the shipped app is the
 * web export running in the Capacitor WebView — an Alert-based confirm would
 * never resolve and the update could never be accepted. `window.confirm` is
 * backed by Capacitor's BridgeWebChromeClient and renders a native dialog
 * there; real native RN (no `window.confirm`) keeps the two-button Alert.
 */
export function confirmUpdate(versionName: string): Promise<boolean> {
  const title = i18n.t('updates.available', { v: versionName });
  const message = i18n.t('updates.confirm', { v: versionName });
  const shell = globalThis as unknown as { confirm?: (m: string) => boolean };
  if (typeof shell.confirm === 'function') {
    try {
      return Promise.resolve(shell.confirm(`${title}\n\n${message}`));
    } catch {
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: i18n.t('updates.install'), onPress: () => resolve(true) },
    ]);
  });
}

/** Download + verify + install a newer APK (no-op off-device). */
export type InstallErrorCode =
  | "aborted"
  | "invalid"
  | "conflict"
  | "storage"
  | "blocked"
  | "checksum"
  | "download"
  | "incompatible"
  | "timeout"
  | "unknown";

export type InstallResult = { ok: true } | { ok: false; code: InstallErrorCode; detail?: string };

/** PackageInstaller.STATUS_* → why the session failed (`UpdateReceiver` rejects
 *  with `install status <code>`; 0 never reaches us). Values are the SDK
 *  constants, not sequential: 2=BLOCKED, 3=ABORTED, 4=INVALID, 5=CONFLICT,
 *  6=STORAGE, 7=INCOMPATIBLE, 8=TIMEOUT. */
const STATUS_REASON: Record<number, InstallErrorCode> = {
  1: "unknown", // STATUS_FAILURE
  2: "blocked", // STATUS_FAILURE_BLOCKED — Play Protect / device policy
  3: "aborted", // STATUS_FAILURE_ABORTED
  4: "invalid", // STATUS_FAILURE_INVALID — not newer than the installed build
  5: "conflict", // STATUS_FAILURE_CONFLICT — signature mismatch
  6: "storage", // STATUS_FAILURE_STORAGE
  7: "incompatible", // STATUS_FAILURE_INCOMPATIBLE — SDK/ABI
  8: "timeout", // STATUS_FAILURE_TIMEOUT
};

function classify(err: unknown): InstallResult {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const status = /install status (\d+)/.exec(msg);
  if (status) return { ok: false, code: STATUS_REASON[Number(status[1])] ?? "unknown", detail: msg };
  if (msg.includes("sha256 mismatch")) return { ok: false, code: "checksum", detail: msg };
  if (msg.startsWith("download failed")) return { ok: false, code: "download", detail: msg };
  return { ok: false, code: "unknown", detail: msg || undefined };
}

export async function installUpdate(info: UpdateInfo): Promise<InstallResult> {
  const p = plugin();
  if (!p || !info.url) return { ok: false, code: "unknown" };
  try {
    const res = await p.install({ url: info.url, sha256: info.sha256 });
    if (res?.success) return { ok: true };
    return { ok: false, code: "unknown", detail: res ? `status ${res.status}` : undefined };
  } catch (e) {
    return classify(e);
  }
}

/** Localized sentence for a failed install, for callers without a status line. */
export function installFailureText(res: Extract<InstallResult, { ok: false }>): string {
  return i18n.t("updates.failedDetail", { reason: i18n.t(`updates.err.${res.code}`) });
}

/**
 * Show a native dialog. react-native-web's `Alert.alert` is a no-op in the
 * Capacitor WebView; `window.alert` goes through the BridgeWebChromeClient and
 * renders natively there (it degrades to the RN Alert in a native build).
 */
export function notify(title: string, message: string): void {
  const shell = globalThis as unknown as { alert?: (m: string) => void };
  if (typeof shell.alert === "function") {
    try {
      shell.alert(`${title}\n\n${message}`);
      return;
    } catch {
      /* fall through */
    }
  }
  Alert.alert(title, message);
}
