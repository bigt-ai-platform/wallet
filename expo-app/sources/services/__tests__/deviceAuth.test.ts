import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * In a plain browser the Android `DeviceAuth` plugin does not exist. The gate
 * must therefore report `unavailable` (so `TransactionConfirmProvider` falls
 * back to the wallet-password prompt) and must not call `registerPlugin`.
 */
const { registerPlugin } = vi.hoisted(() => ({
  registerPlugin: vi.fn(() => ({
    isAvailable: async () => ({ available: true }),
    confirm: async () => ({ ok: true }),
  })),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: (...args: unknown[]) => (registerPlugin as (...a: unknown[]) => unknown)(...args),
}));

function setCapacitor(platform: 'android' | 'web' | null) {
  (globalThis as { Capacitor?: unknown }).Capacitor = platform
    ? { isNativePlatform: () => platform === 'android', getPlatform: () => platform }
    : undefined;
}

beforeEach(() => {
  vi.resetModules();
  registerPlugin.mockClear();
});

describe('deviceAuth (browser)', () => {
  it('is unavailable in a plain browser and never registers a plugin', async () => {
    setCapacitor(null);
    const m = await import('../deviceAuth');
    expect(m.isDeviceUnlockSupported()).toBe(false);
    expect(await m.confirmWithDeviceUnlock()).toBe('unavailable');
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it('is unavailable on the web platform (Capacitor web)', async () => {
    setCapacitor('web');
    const m = await import('../deviceAuth');
    expect(m.isDeviceUnlockSupported()).toBe(false);
    expect(await m.confirmWithDeviceUnlock()).toBe('unavailable');
  });
});

describe('deviceAuth (android)', () => {
  it('uses the native plugin when the OS credential is available', async () => {
    setCapacitor('android');
    const m = await import('../deviceAuth');
    expect(m.isDeviceUnlockSupported()).toBe(true);
    expect(await m.confirmWithDeviceUnlock({ title: 'Confirm' })).toBe('ok');
    expect(registerPlugin).toHaveBeenCalledWith('DeviceAuth');
  });

  it('reports unavailable when the OS has no credential set (falls back to password)', async () => {
    setCapacitor('android');
    registerPlugin.mockReturnValueOnce({
      isAvailable: async () => ({ available: false }),
      confirm: async () => ({ ok: true }),
    });
    const m = await import('../deviceAuth');
    expect(await m.confirmWithDeviceUnlock()).toBe('unavailable');
  });

  it('reports denied when the user cancels the prompt', async () => {
    setCapacitor('android');
    registerPlugin.mockReturnValueOnce({
      isAvailable: async () => ({ available: true }),
      confirm: async () => ({ ok: false }),
    });
    const m = await import('../deviceAuth');
    expect(await m.confirmWithDeviceUnlock()).toBe('denied');
  });
});
