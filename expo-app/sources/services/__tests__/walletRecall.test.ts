import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    native: { enabled: false },
  };
});

vi.mock('@/lib/platform', () => ({
  isCapacitorNative: () => mocks.native.enabled,
}));

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

import {
  forgetWalletUnlock,
  getRememberDeviceUnlock,
  getRememberedWalletUnlock,
  hasRememberedWalletUnlock,
  rememberWalletUnlock,
  setRememberDeviceUnlock,
} from '../walletRecall';

describe('walletRecall (remembered device unlock, like ../dai)', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.native.enabled = false;
  });

  it('is enabled by default and remembers nothing on the web', () => {
    expect(getRememberDeviceUnlock()).toBe(true);
    rememberWalletUnlock('s3cret');
    expect(getRememberedWalletUnlock()).toBeNull();
    expect(hasRememberedWalletUnlock()).toBe(false);
  });

  it('stores the unlock on native so the OS credential can release it', () => {
    mocks.native.enabled = true;
    rememberWalletUnlock('s3cret');
    expect(getRememberedWalletUnlock()).toBe('s3cret');
    expect(hasRememberedWalletUnlock()).toBe(true);
    // the password is the only value; the wallet file itself is untouched
    expect(Array.from(mocks.store.keys())).toEqual(['wallet.deviceUnlock']);
  });

  it('ignores an empty password', () => {
    mocks.native.enabled = true;
    rememberWalletUnlock('');
    expect(hasRememberedWalletUnlock()).toBe(false);
  });

  it('forgets the unlock when the user turns the option off', () => {
    mocks.native.enabled = true;
    rememberWalletUnlock('s3cret');
    setRememberDeviceUnlock(false);
    expect(getRememberDeviceUnlock()).toBe(false);
    expect(hasRememberedWalletUnlock()).toBe(false);
    // and does not re-remember while off
    rememberWalletUnlock('again');
    expect(hasRememberedWalletUnlock()).toBe(false);
  });

  it('can forget explicitly (wallet deletion)', () => {
    mocks.native.enabled = true;
    rememberWalletUnlock('s3cret');
    forgetWalletUnlock();
    expect(hasRememberedWalletUnlock()).toBe(false);
  });
});
