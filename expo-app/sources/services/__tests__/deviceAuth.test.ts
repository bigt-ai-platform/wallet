import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ isAvailable: mocks.isAvailable, confirm: mocks.confirm }),
}));

import { confirmWithDeviceUnlock } from '../deviceAuth';

describe('confirmWithDeviceUnlock', () => {
  beforeEach(() => {
    mocks.isAvailable.mockReset();
    mocks.confirm.mockReset();
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports success and denial from the OS prompt', async () => {
    mocks.isAvailable.mockResolvedValue({ available: true });
    mocks.confirm.mockResolvedValueOnce({ ok: true });
    await expect(confirmWithDeviceUnlock()).resolves.toBe('ok');

    mocks.confirm.mockResolvedValueOnce({ ok: false, code: 13 });
    await expect(confirmWithDeviceUnlock()).resolves.toBe('denied');
  });

  it('falls back when the device has no credential', async () => {
    mocks.isAvailable.mockResolvedValue({ available: false, code: 11 });
    await expect(confirmWithDeviceUnlock()).resolves.toBe('unavailable');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('never pends forever when the prompt callback is lost', async () => {
    // Regression: auto-opening BiometricPrompt during a screen transition could
    // drop the AuthenticationCallback, leaving the unlock button stuck on
    // "解锁中…" forever. The call must resolve on its own.
    vi.useFakeTimers();
    mocks.isAvailable.mockResolvedValue({ available: true });
    mocks.confirm.mockReturnValue(new Promise(() => {}));

    const pending = confirmWithDeviceUnlock();
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(pending).resolves.toBe('unavailable');
  });
});
