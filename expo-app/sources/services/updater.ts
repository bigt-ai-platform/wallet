/**
 * OTA updater bridge (Capacitor/Android only).
 *
 * The web layer resolves the region release manifest, compares its versionCode
 * against the installed build, and drives the native `Updater` plugin:
 * `getVersion` reads the installed versionCode, `install` downloads + verifies
 * sha256 + installs the signed APK via PackageInstaller. In a plain browser
 * this is a no-op (the Android APK is the only installable artifact).
 */
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

/** Registered only on the native platform; null otherwise. */
async function plugin(): Promise<UpdaterPlugin | null> {
  if (cached !== undefined) return cached;
  if (!isNative()) {
    cached = null;
    return null;
  }
  try {
    const { registerPlugin } = (await import('@capacitor/core')) as {
      registerPlugin: <T>(name: string) => T;
    };
    cached = registerPlugin<UpdaterPlugin>('Updater');
  } catch {
    cached = null;
  }
  return cached;
}

/** Current installed version, or null off-device. */
export async function currentVersion(): Promise<InstalledVersion | null> {
  const p = await plugin();
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

/** Ask the user before a non-mandatory OTA install. Resolves false on dismiss. */
export function confirmUpdate(versionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('updates.available', { v: versionName }),
      i18n.t('updates.confirm', { v: versionName }),
      [
        { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: i18n.t('updates.install'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Download + verify + install a newer APK (no-op off-device). */
export async function installUpdate(info: UpdateInfo): Promise<boolean> {
  const p = await plugin();
  if (!p || !info.url) return false;
  try {
    const res = await p.install({ url: info.url, sha256: info.sha256 });
    return !!res?.success;
  } catch {
    return false;
  }
}
