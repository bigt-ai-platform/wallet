import { describe, expect, it } from 'vitest';
import { EXTERNAL_ASSETS, HKD, GOLD, ETH_TOKEN } from '../externalAssets';
import { mergeExternalBalances } from '../externalPortfolio';

describe('external portfolio merge', () => {
  it('keeps known assets with a positive balance', () => {
    const rows = mergeExternalBalances(
      [HKD, GOLD, ETH_TOKEN],
      [
        { assetId: 'hkd', available: '1500000' },
        { assetId: 'gold', available: '2500000' },
      ],
    );
    expect(rows.map((r) => r.symbol)).toEqual(['GOLD', 'HKD']); // largest raw first
    expect(rows[0].amount).toBe('2.5');
    expect(rows[1].amount).toBe('1.5');
  });

  it('drops zero, unknown and malformed balances', () => {
    const rows = mergeExternalBalances(
      EXTERNAL_ASSETS,
      [
        { assetId: 'hkd', available: '0' },
        { assetId: 'doge', available: '999' },
        { assetId: 'usd', available: 'not-a-number' },
        { assetId: 'gold', available: '1' },
      ],
    );
    expect(rows.map((r) => r.symbol)).toEqual(['GOLD']);
  });

  it('formats with each asset owns decimals', () => {
    const rows = mergeExternalBalances([HKD, ETH_TOKEN], [
      { assetId: 'hkd', available: '1234567' },
      { assetId: 'eth', available: '1000' },
    ]);
    expect(rows.find((r) => r.symbol === 'HKD')?.amount).toBe('1.234567');
    expect(rows.find((r) => r.symbol === 'ETH')?.amount).toBe('0.001');
  });

  it('returns nothing when the distributor reported nothing', () => {
    expect(mergeExternalBalances(EXTERNAL_ASSETS, [])).toEqual([]);
  });
});
