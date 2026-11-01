import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    native: { enabled: false },
    check: vi.fn(),
    request: vi.fn(),
    notify: vi.fn(),
  };
});

vi.mock('@/lib/platform', () => ({
  isCapacitorNative: () => mocks.native.enabled,
}));

vi.mock('@capacitor/core', () => ({
  // The bridge is the same shape as ../dai's Notifier plugin.
  registerPlugin: () => ({
    checkNotifyPermission: mocks.check,
    requestNotifyPermission: mocks.request,
    notify: mocks.notify,
  }),
}));

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

import {
  ensureNotifyPermission,
  getSystemNotificationsEnabled,
  raiseSystemNotification,
  setSystemNotificationsEnabled,
  shouldRaiseSystemNotification,
  syncNotifyPermission,
} from '../systemNotifications';
import { notifySystemMessage } from '../systemMessages';

describe('systemNotifications', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.native.enabled = false;
    mocks.check.mockReset();
    mocks.request.mockReset();
    mocks.notify.mockReset();
    vi.unstubAllGlobals();
    // reset the module-level permission cache through a fresh sync
    mocks.check.mockResolvedValue({ granted: false });
  });

  it('is on by default and persists the setting', () => {
    expect(getSystemNotificationsEnabled()).toBe(true);
    setSystemNotificationsEnabled(false);
    expect(getSystemNotificationsEnabled()).toBe(false);
    expect(mocks.store.get('settings.notifySystem')).toBe('false');
  });

  it('gates on pref, OS permission and foreground state', () => {
    const base = { enabled: true, permission: 'granted', hidden: true };
    expect(shouldRaiseSystemNotification(base)).toBe(true);
    expect(shouldRaiseSystemNotification({ ...base, enabled: false })).toBe(false);
    expect(shouldRaiseSystemNotification({ ...base, permission: 'denied' })).toBe(false);
    expect(shouldRaiseSystemNotification({ ...base, permission: 'default' })).toBe(false);
    // in the foreground the in-app banner already shows it
    expect(shouldRaiseSystemNotification({ ...base, hidden: false })).toBe(false);
  });

  it('asks for the OS permission through the Notifier plugin on native', async () => {
    mocks.native.enabled = true;
    mocks.request.mockResolvedValue({ granted: true });
    await expect(ensureNotifyPermission()).resolves.toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('learns an already-granted permission without prompting', async () => {
    mocks.native.enabled = true;
    mocks.check.mockResolvedValue({ granted: true });
    await syncNotifyPermission();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('posts through the native Notifier when backgrounded', async () => {
    mocks.native.enabled = true;
    mocks.check.mockResolvedValue({ granted: true });
    mocks.notify.mockResolvedValue({ posted: true });
    await syncNotifyPermission();
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    await expect(
      raiseSystemNotification({ title: 'Payment finalized', body: '1 BIG', tag: 'sys_1' }),
    ).resolves.toBe(true);

    expect(mocks.notify).toHaveBeenCalledWith({
      title: 'Payment finalized',
      body: '1 BIG',
      tag: 'sys_1',
    });
  });

  it('does not post while the app is in the foreground', async () => {
    mocks.native.enabled = true;
    mocks.check.mockResolvedValue({ granted: true });
    await syncNotifyPermission();
    vi.stubGlobal('document', { visibilityState: 'visible' });

    await expect(raiseSystemNotification({ title: 'x' })).resolves.toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('mirrors every chain event message to the OS', async () => {
    mocks.native.enabled = true;
    mocks.check.mockResolvedValue({ granted: true });
    mocks.notify.mockResolvedValue({ posted: true });
    await syncNotifyPermission();
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    notifySystemMessage({ tone: 'success', title: 'Payment finalized', body: '1 BIG reached' });

    // fire-and-forget
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0].title).toBe('Payment finalized');
    expect(mocks.notify.mock.calls[0][0].tag).toMatch(/^sys_/);
  });
});
