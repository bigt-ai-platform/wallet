import { describe, expect, it } from 'vitest';
import { assetsFromEnv } from '../src/config.js';

const base = {
  assetId: 'usdt',
  symbol: 'USDT',
  depositKind: 'evm',
  externalDecimals: 6,
  l1Decimals: 6,
  maxSupplyRaw: '1000',
  maxMintRaw: '100',
};

describe('ASSETS_JSON', () => {
  it('carries the deposit address model and xpub path', () => {
    const [asset] = assetsFromEnv(JSON.stringify([{
      ...base,
      depositAddressMode: 'per-user',
      depositXpubPath: '0',
      custodyAddress: '0x1111111111111111111111111111111111111111',
    }]));
    expect(asset).toMatchObject({
      assetId: 'usdt',
      depositAddressMode: 'per-user',
      depositXpubPath: '0',
    });
  });

  it('refuses an unknown address mode instead of treating it as static', () => {
    expect(() => assetsFromEnv(JSON.stringify([{ ...base, depositAddressMode: 'perUser' }])))
      .toThrow(/depositAddressMode/);
  });
});
