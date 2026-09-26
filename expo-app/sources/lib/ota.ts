/**
 * OTA release-manifest helpers (no React/Capacitor imports, so it is unit
 * testable in isolation).
 *
 * `deploy.apk.sh` uploads next to each release APK a
 * `wallet-<env>-<type>-latest.json` manifest holding the semver + monotonic
 * versionCode plus the public APK url and its sha256. The app fetches the
 * manifest, compares versionCode against the installed build, and (when newer)
 * hands the url + sha256 to the native Updater plugin to download and install.
 */

export interface OtaManifest {
  versionName: string;
  versionCode: number;
  url: string;
  sha256: string;
  mandatory: boolean;
}

export interface InstalledVersion {
  versionCode: number;
  versionName: string;
}

export interface UpdateInfo extends OtaManifest {
  hasUpdate: boolean;
  currentVersionCode: number;
}

/** Manifest object name for a release channel, e.g. `wallet-production-release-latest.json`. */
export function manifestName(env: string, type = "release"): string {
  return `wallet-${env}-${type}-latest.json`;
}

/** Absolute manifest URL under the (public-read) release bucket prefix. */
export function manifestUrl(base: string, env: string, type = "release"): string {
  return `${base.replace(/\/+$/, "")}/${manifestName(env, type)}`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Validate + normalize a decoded manifest. Returns null when the payload is not
 * a usable release (missing url or non-positive versionCode), so a corrupt or
 * wrong-format object can never trigger an install.
 */
export function parseManifest(raw: unknown): OtaManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const versionCode = Number(m.versionCode);
  const url = asString(m.url);
  if (!Number.isFinite(versionCode) || versionCode <= 0 || !url) return null;
  return {
    versionName: asString(m.versionName),
    versionCode,
    url,
    sha256: asString(m.sha256),
    mandatory: m.mandatory === true,
  };
}

/** True when the manifest describes a strictly newer build. */
export function hasUpdate(manifest: OtaManifest | null, currentVersionCode: number): boolean {
  if (!manifest) return false;
  if (!Number.isFinite(currentVersionCode)) return false;
  return manifest.versionCode > currentVersionCode;
}

/** Combine a manifest with the installed version into the UI-facing decision. */
export function updateInfo(manifest: OtaManifest, currentVersionCode: number): UpdateInfo {
  return {
    ...manifest,
    hasUpdate: hasUpdate(manifest, currentVersionCode),
    currentVersionCode,
  };
}

/** Fetch + parse a manifest. Returns null on any network/format failure. */
export async function fetchManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OtaManifest | null> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    return null;
  }
}
