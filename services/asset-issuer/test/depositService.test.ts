import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetConfig } from '../src/config.js';
import { ensureDepositAddress } from '../src/depositService.js';
import { MemoryStore } from '../src/store.js';

const XPUB = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';

const asset: AssetConfig = {
  assetId: 'usdt',
  symbol: 'USDT',
  depositKind: 'evm',
  depositAddressMode: 'per-user',
  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  custodyAddress: '0x1111111111111111111111111111111111111111',
  l1TokenId: 'token',
  externalDecimals: 6,
  l1Decimals: 6,
  maxSupplyRaw: 10n ** 18n,
  maxMintRaw: 10n ** 12n,
  enabled: true,
};

let store: MemoryStore;
const options = () => ({
  store,
  asset,
  xpub: XPUB,
  path: '',
  now: () => '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  store = new MemoryStore();
});

describe('per-user deposit address allocation', () => {
  it('is idempotent for one account and unique across accounts', async () => {
    const first = await ensureDepositAddress(options(), 'l1-account-1');
    const again = await ensureDepositAddress(options(), 'l1-account-1');
    const second = await ensureDepositAddress(options(), 'l1-account-2');

    expect(again.address).toBe(first.address);
    expect(second.address).not.toBe(first.address);
    expect(first.addressIndex).toBe(0);
    expect(second.addressIndex).toBe(1);
    expect(first.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('survives a concurrent allocation race without duplicate indices', async () => {
    const accounts = Array.from({ length: 8 }, (_, i) => `l1-${i}`);
    const records = await Promise.all(accounts.map((a) => ensureDepositAddress(options(), a)));

    expect(new Set(records.map((r) => r.address)).size).toBe(8);
    expect(new Set(records.map((r) => r.addressIndex)).size).toBe(8);
    expect((await store.listDepositAddresses('usdt'))).toHaveLength(8);
  });

  it('never reuses an address across assets (one holder per address)', async () => {
    const first = await ensureDepositAddress(options(), 'l1-1');
    const usdc = { ...asset, assetId: 'usdc', symbol: 'USDC' };
    const second = await ensureDepositAddress({ ...options(), asset: usdc }, 'l1-1');

    expect(second.address).not.toBe(first.address);
    expect(second.addressIndex).toBe(1);
    expect(await store.findAccountByDepositAddress('usdc', first.address)).toBeUndefined();
  });

  it('resolves the L1 account from the allocated address', async () => {
    const record = await ensureDepositAddress(options(), 'l1-account-1');
    expect(await store.findAccountByDepositAddress('usdt', record.address.toUpperCase())).toBe('l1-account-1');
    expect(await store.findAccountByDepositAddress('usdt', '0xdead')).toBeUndefined();
  });
});
