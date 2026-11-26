import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store };
});

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

import {
  clearPendingRedemptionFunding, loadPendingRedemptionFundings,
  matchingPendingRedemptionFunding, redemptionMemo, savePendingRedemptionFunding,
} from '../redeemFunding';

const ACCOUNT = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';

function save(txHash: string, amountRaw: string, network: 'Test' | 'Mainnet' = 'Mainnet') {
  return savePendingRedemptionFunding({
    txHash,
    account: ACCOUNT,
    assetId: 'usdt',
    amountRaw,
    memo: redemptionMemo('usdt', amountRaw, ACCOUNT),
    network,
  });
}

describe('redemption funding memo', () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it('matches the issuer vector exactly', () => {
    expect(redemptionMemo('USDT', '5000000', ACCOUNT))
      .toBe(`wallet-redeem:v1:usdt:5000000:${ACCOUNT}`);
  });

  it('keeps one record per outpoint and only reuses the matching funding', () => {
    save('0xfirst', '5000000');
    save('0xsecond', '7000000');

    expect(loadPendingRedemptionFundings().map((r) => r.txHash)).toEqual(['0xfirst', '0xsecond']);
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'usdt', '5000000', 'Mainnet')?.txHash).toBe('0xfirst');
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'usdt', '7000000', 'Mainnet')?.txHash).toBe('0xsecond');
    // A different account, asset, amount or network must send a fresh payment.
    expect(matchingPendingRedemptionFunding('someone-else', 'usdt', '5000000', 'Mainnet')).toBeNull();
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'hkd', '5000000', 'Mainnet')).toBeNull();
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'usdt', '4000000', 'Mainnet')).toBeNull();
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'usdt', '5000000', 'Test')).toBeNull();

    // Clearing one outpoint leaves the other resumable.
    clearPendingRedemptionFunding('0xfirst');
    expect(loadPendingRedemptionFundings().map((r) => r.txHash)).toEqual(['0xsecond']);
    clearPendingRedemptionFunding();
    expect(loadPendingRedemptionFundings()).toEqual([]);
  });

  it('keeps distinct returns for the same account/asset/amount', () => {
    save('0xold', '5000000');
    save('0xnew', '5000000');
    expect(loadPendingRedemptionFundings().map((r) => r.txHash)).toEqual(['0xold', '0xnew']);
    // Both are resumable; the UI lets the user pick, the helper returns the first.
    expect(matchingPendingRedemptionFunding(ACCOUNT, 'usdt', '5000000', 'Mainnet')?.txHash)
      .toBe('0xold');
  });

  it('ignores malformed saved records', () => {
    mocks.store.set('redeem.pendingFunding', '{not json');
    expect(loadPendingRedemptionFundings()).toEqual([]);
    mocks.store.set('redeem.pendingFunding', JSON.stringify([{ txHash: 'x' }]));
    expect(loadPendingRedemptionFundings()).toEqual([]);
  });
});
