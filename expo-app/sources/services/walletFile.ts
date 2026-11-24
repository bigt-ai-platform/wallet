/**
 * Wallet-file persistence for the three runtimes this app ships in.
 *
 * 1. Android app (Capacitor WebView, `isCapacitorNative()` true): the WebView
 *    has no `showSaveFilePicker`, and `<a download>` is a no-op unless a
 *    `DownloadListener` is installed (the Capacitor shell has none), so the
 *    browser path silently saved nothing on the phone. The native `WalletFile`
 *    plugin writes the file to the public Downloads collection (API 29+) — or
 *    the app's external documents dir on older releases — and returns a
 *    content:// uri the share sheet can hand to Files/Drive/mail.
 * 2. Browser (desktop/mobile web): File System Access picker when available,
 *    otherwise the anchor download the Playwright e2e asserts.
 * 3. React-Native native build (`expo run:android|ios`): legacy
 *    expo-file-system API (the default `expo-file-system` export is the new
 *    File/Directory API since SDK 54 and has no `documentDirectory` /
 *    `writeAsStringAsync`), then the system share sheet.
 *
 * `registerPlugin` is imported statically on purpose: Metro turns a dynamic
 * `import('@capacitor/core')` into `_asyncRequire`, which never settles in this
 * WebView (see services/binaryPost.ts). The returned proxy must never be
 * awaited (its `.then` probe is rejected by Capacitor), so it is cached and
 * used once.
 */
import { registerPlugin } from "@capacitor/core";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { isCapacitorNative } from "@/lib/platform";

interface WalletFilePlugin {
  /** Write the JSON to the device; resolves with the content:// uri. */
  save(opts: {
    fileName: string;
    content: string;
    mimeType?: string;
  }): Promise<{ uri: string; fileName?: string; location?: string }>;
  /** Open the Android share sheet for a previously saved uri. */
  share(opts: {
    uri: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<{ shared: boolean }>;
}

export interface SavedWalletFile {
  /** File name to show to the user. */
  fileName: string;
  /** Human-readable place the copy landed (Downloads/…, app documents, browser). */
  location?: string;
}

const MIME_JSON = "application/json";

let cached: WalletFilePlugin | null | undefined;

function nativePlugin(): WalletFilePlugin | null {
  if (cached !== undefined) return cached;
  if (!isCapacitorNative()) {
    cached = null;
    return null;
  }
  try {
    cached = registerPlugin<WalletFilePlugin>("WalletFile");
  } catch {
    cached = null;
  }
  return cached;
}

/** True in the Android app where the native WalletFile bridge exists. */
export function isNativeWalletFileSaveSupported(): boolean {
  return nativePlugin() !== null;
}

/** True in a browser-like runtime (web export, web server, Capacitor WebView). */
function isBrowserRuntime(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

/** Write through the native plugin, then offer the share sheet (non-fatal). */
export async function saveViaNativePlugin(
  content: string,
  fileName: string,
): Promise<SavedWalletFile> {
  const plugin = nativePlugin();
  if (!plugin) throw new Error("native wallet-file bridge is not available");
  const saved = await plugin.save({
    fileName,
    content,
    mimeType: MIME_JSON,
  });
  // The copy is already in Downloads; a dismissed or unavailable share target
  // must not turn a successful save into an error.
  if (saved?.uri) {
    try {
      await plugin.share({
        uri: saved.uri,
        fileName: saved.fileName ?? fileName,
        mimeType: MIME_JSON,
      });
    } catch {
      /* no share target / user dismissed */
    }
  }
  return {
    fileName: saved?.fileName ?? fileName,
    location: saved?.location,
  };
}

/**
 * Android/iOS Chrome exposes `showSaveFilePicker`, but its Downloads provider
 * writes a 0-byte file and then rejects the picker with AbortError (verified
 * on Chrome 157 / Android 14: the sheet saves an empty `wallet_….json`), which
 * the caller reports as "save cancelled" and leaves the user without a backup.
 * The anchor download writes the same bytes correctly there, so keep the
 * picker for desktop browsers only.
 */
function isMobileBrowser(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator
    ?.userAgent;
  return typeof ua === "string" && /Android|iPhone|iPad|iPod/i.test(ua);
}

/** Browser download: File System Access picker, else an `<a download>` click. */
export async function saveViaBrowser(
  content: string,
  fileName: string,
): Promise<SavedWalletFile> {
  const blob = new Blob([content], { type: MIME_JSON });
  const picker = (globalThis as { showSaveFilePicker?: unknown })
    .showSaveFilePicker;
  if (typeof picker === "function" && !isMobileBrowser()) {
    const handle = await (
      picker as (opts: unknown) => Promise<{
        createWritable: () => Promise<{
          write: (b: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>
    )({
      suggestedName: fileName,
      types: [
        {
          description: "JSON Wallet File",
          accept: { "application/json": [".json"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { fileName };
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Mobile browsers fetch the blob after the click returns; revoking in the
  // same tick truncates the download to 0 bytes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { fileName };
}

/** React-Native native build: documents dir + share sheet. */
export async function saveViaNativeFileSystem(
  content: string,
  fileName: string,
): Promise<SavedWalletFile> {
  const documentsDir = FileSystem.documentDirectory;
  if (!documentsDir) throw new Error("Documents directory not available");
  const filePath = `${documentsDir}${fileName}`;
  await FileSystem.writeAsStringAsync(filePath, content);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(filePath, {
      mimeType: MIME_JSON,
      dialogTitle: fileName,
      UTI: "public.json",
    });
  }
  return { fileName, location: filePath };
}

/**
 * Save a wallet backup on whatever runtime the app is running in.
 *
 * A dismissed native share sheet is not an error (the file is already saved);
 * a dismissed browser save picker rejects with `AbortError`, which callers
 * treat as "cancelled" rather than a failure.
 */
export async function saveWalletFileToDevice(
  content: string,
  fileName: string,
): Promise<SavedWalletFile> {
  if (nativePlugin()) return saveViaNativePlugin(content, fileName);
  if (isBrowserRuntime()) return saveViaBrowser(content, fileName);
  return saveViaNativeFileSystem(content, fileName);
}
