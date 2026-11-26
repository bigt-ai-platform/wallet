import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const defaults = { apiUrl: '', issuerAddress: '', minUsdt: '', apiToken: '' };
  return { store, defaults };
});

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

// Getters so each test can change the build-time defaults.
vi.mock('@/constants/app', () => ({
  get ISSUER_API_URL() { return mocks.defaults.apiUrl; },
  get ISSUER_DEPOSIT_ADDRESS() { return mocks.defaults.issuerAddress; },
  get ISSUER_MIN_USDT() { return mocks.defaults.minUsdt; },
  get ISSUER_API_TOKEN() { return mocks.defaults.apiToken; },
}));

import {
  getBridgeSettings, getDepositAddress, isBridgeConfigured, setBridgeSettings,
} from '../ethBridge';

beforeEach(() => {
  mocks.store.clear();
  mocks.defaults.apiUrl = '';
  mocks.defaults.issuerAddress = '';
  mocks.defaults.minUsdt = '';
  mocks.defaults.apiToken = '';
});

describe('USDT bridge settings', () => {
  it('is unconfigured when neither a default nor an override exists', () => {
    expect(isBridgeConfigured()).toBe(false);
    expect(getBridgeSettings()).toEqual({ apiUrl: '', issuerAddress: '', minUsdt: '', apiToken: '' });
  });

  it('uses the build-time defaults without any user input', () => {
    mocks.defaults.apiUrl = 'https://issuer.example/api';
    mocks.defaults.issuerAddress = '0x1111111111111111111111111111111111111111';
    mocks.defaults.minUsdt = '10';

    expect(isBridgeConfigured()).toBe(true);
    expect(getBridgeSettings()).toEqual({
      apiUrl: 'https://issuer.example/api',
      issuerAddress: '0x1111111111111111111111111111111111111111',
      minUsdt: '10',
      apiToken: '',
    });
  });

  it('lets a device override win over the default, field by field', () => {
    mocks.defaults.apiUrl = 'https://issuer.example/api';
    mocks.defaults.issuerAddress = '0x1111111111111111111111111111111111111111';

    setBridgeSettings({ issuerAddress: ' 0x2222222222222222222222222222222222222222 ' });
    expect(getBridgeSettings()).toEqual({
      // untouched by the override → still the build-time default
      apiUrl: 'https://issuer.example/api',
      issuerAddress: '0x2222222222222222222222222222222222222222',
      minUsdt: '',
      apiToken: '',
    });
  });

  it('keeps working when only the status API is configured', () => {
    mocks.defaults.apiUrl = 'https://issuer.example/api';
    expect(isBridgeConfigured()).toBe(true);
  });

  it('sends the bearer token to the issuer API', async () => {
    mocks.defaults.apiUrl = 'https://issuer.example';
    mocks.defaults.apiToken = 'secret';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ address: '0x1111111111111111111111111111111111111111' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getDepositAddress('l1-account', 'usdt');
    expect(result?.address).toBe('0x1111111111111111111111111111111111111111');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.example/deposit-address?account=l1-account&assetId=usdt',
      { headers: { authorization: 'Bearer secret' } },
    );
    vi.unstubAllGlobals();
  });
});
