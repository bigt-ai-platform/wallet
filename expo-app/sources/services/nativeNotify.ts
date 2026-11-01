/**
 * Native system-notification bridge — the same contract as `../dai`
 * (`apps/web/src/lib/nativeNotify.ts` + `apps/webapp/native/notifier`).
 *
 * The Android System WebView has no `Notification` constructor, so the native
 * `Notifier` plugin (`webapp/native/notifier`) owns the channel, the
 * POST_NOTIFICATIONS runtime permission and posting. On the web this reports
 * unavailable and callers fall back to the in-app banner only.
 *
 * `registerPlugin` is imported statically on purpose: a dynamic
 * `import('@capacitor/core')` is compiled by Metro to `_asyncRequire(id,
 * {paths})`, which never settles in this WebView (see services/binaryPost.ts).
 */

import { registerPlugin } from '@capacitor/core';
import { isCapacitorNative } from '@/lib/platform';

interface NotifierPlugin {
  checkNotifyPermission(): Promise<{ granted: boolean }>;
  requestNotifyPermission(): Promise<{ granted: boolean }>;
  notify(options: { title: string; body?: string; tag?: string }): Promise<{ posted: boolean }>;
}

/** Registered only on native; null on the web/server. */
function plugin(): NotifierPlugin | null {
  if (!isCapacitorNative()) return null;
  try {
    return registerPlugin<NotifierPlugin>('Notifier');
  } catch {
    return null;
  }
}

/** True when the native Notifier bridge is present (Android app, not browser). */
export function nativeNotifyAvailable(): boolean {
  return plugin() !== null;
}

/** Read the current OS permission without prompting. */
export async function nativeCheckNotifyPermission(): Promise<boolean | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return (await p.checkNotifyPermission()).granted;
  } catch {
    return null;
  }
}

/** Prompt for the OS permission (no-op/true when already granted, Android <13). */
export async function nativeRequestNotifyPermission(): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    return (await p.requestNotifyPermission()).granted;
  } catch {
    return false;
  }
}

/** Post a system notification; false when unavailable or blocked. */
export async function nativePostNotification(data: {
  title: string;
  body?: string;
  tag?: string;
}): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    return (await p.notify(data)).posted;
  } catch {
    return false;
  }
}
