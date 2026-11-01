/**
 * System (OS) notifications for chain events — the wallet's counterpart of
 * `../dai`'s `lib/notify.ts`.
 *
 * `services/systemMessages.ts` owns the in-app banner + notification centre.
 * This module mirrors every message to the operating system through the native
 * `Notifier` plugin (Android, channel `wallet_events`), so a payment that
 * finalizes while the app is in the background is not missed. Same gate as dai:
 * the user can switch it off in Settings, the OS permission must be granted,
 * and a message that already shows as an in-app banner (app in the foreground)
 * is not duplicated.
 */

import { device } from '@/storage';
import {
  nativeCheckNotifyPermission,
  nativeNotifyAvailable,
  nativePostNotification,
  nativeRequestNotifyPermission,
} from './nativeNotify';

const ENABLED_KEY = ['settings', 'notifySystem'];

/** Device-local pref; on unless the user turned it off. */
export function getSystemNotificationsEnabled(): boolean {
  return device.get(ENABLED_KEY) !== 'false';
}

export function setSystemNotificationsEnabled(enabled: boolean): void {
  device.set(ENABLED_KEY, enabled ? 'true' : 'false');
}

export type NotifyPermission = 'granted' | 'denied' | 'default';

let permission: NotifyPermission = 'default';

/** True when the platform can raise OS notifications at all. */
export function systemNotificationsSupported(): boolean {
  return nativeNotifyAvailable() || typeof Notification !== 'undefined';
}

/** Read the OS permission once (no prompt) so an already-granted app can
 *  notify from the first event instead of treating it as unanswered. */
export async function syncNotifyPermission(): Promise<void> {
  if (!nativeNotifyAvailable()) return;
  const granted = await nativeCheckNotifyPermission();
  if (granted !== null) permission = granted ? 'granted' : 'denied';
}

/** Ask for the OS permission if it was never answered; true when we may post. */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (nativeNotifyAvailable()) {
    const granted = await nativeRequestNotifyPermission();
    permission = granted ? 'granted' : 'denied';
    return granted;
  }
  if (!systemNotificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    permission = result === 'granted' ? 'granted' : 'denied';
    return result === 'granted';
  } catch {
    return false;
  }
}

/** Pure gate (exported for tests): pref on, OS permission, app not in front. */
export function shouldRaiseSystemNotification(i: {
  enabled: boolean;
  permission: NotifyPermission | string;
  hidden: boolean;
}): boolean {
  if (!i.enabled) return false;
  if (i.permission !== 'granted') return false;
  return i.hidden;
}

function isHidden(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'hidden';
}

/**
 * Mirror an in-app system message to the OS. Fire-and-forget: the message is
 * already stored/rendered, so a blocked or unavailable notification is fine.
 * On the first call after install (permission "default") it asks for the
 * permission instead of dropping the event silently.
 */
export async function raiseSystemNotification(message: {
  title: string;
  body?: string;
  tag?: string;
}): Promise<boolean> {
  if (!systemNotificationsSupported()) return false;
  const enabled = getSystemNotificationsEnabled();
  if (permission === 'default') {
    if (!enabled) return false;
    void ensureNotifyPermission();
    return false;
  }
  if (
    !shouldRaiseSystemNotification({
      enabled,
      permission,
      hidden: isHidden(),
    })
  ) {
    return false;
  }
  if (nativeNotifyAvailable()) {
    return await nativePostNotification(message);
  }
  try {
    new Notification(message.title, { body: message.body, tag: message.tag });
    return true;
  } catch {
    return false;
  }
}
