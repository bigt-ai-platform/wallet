import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ASSETS } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { scanDeposits, scanRedemptions, type ChainClient } from '../src/watcher.js';

let store: MemoryStore;
let tick = 0;
let finalized = 100;
let deposits: Awaited<ReturnType<ChainClient['deposits']>> = [];
let redemptions: Awaited<ReturnType<ChainClient['redemptions']>> = [];

const client: ChainClient = {
  finalizedBlock: async () => finalized,
  deposits: async () => deposits,
  redemptions: async () => redemptions,
};

const options = () => ({
  store,
  client,
  assets: DEFAULT_ASSETS,
  now: () => `2026-01-01T00:00:0${tick++}.000Z`,
  newId: () => `op${tick}`,
});

const deposit = (over: Record<string, unknown> = {}) => ({
  assetId: 'hkd',
  account: 'w1',
  externalRaw: '1500000',
  chain: 'ethereum',
  txHash: '0xABC',
  logIndex: 2,
  blockNumber: 100,
  ...over,
});

beforeEach(() => {
  store = new MemoryStore();
  tick = 0;
  finalized = 100;
  deposits = [];
  redemptions = [];
});

describe('deposit watcher', () => {
  it('records a finalized deposit and credits the reserve without minting', async () => {
    deposits = [deposit()];
    const result = await scanDeposits(options());
    expect(result).toEqual({ recorded: 1, skipped: 0, deferred: 0 });

    const op = await store.findOperationByKey('ethereum:0xabc:2');
    expect(op?.kind).toBe('deposit');
    expect(op?.status).toBe('pending');
    // hkd is 6dp on both sides: 1.5 HKD
    expect(op?.l1AmountRaw).toBe('1500000');

    const reserve = await store.getReserve('hkd');
    expect(reserve?.reserveRaw).toBe(1_500_000n);
    // no supply until the executor mints
    expect(reserve?.supplyRaw).toBe(0n);
  });

  it('defers anything above the finalized block', async () => {
    deposits = [deposit({ blockNumber: 101 })];
    expect(await scanDeposits(options())).toEqual({ recorded: 0, skipped: 0, deferred: 1 });
    expect(await store.getReserve('hkd')).toBeUndefined();
  });

  it('is idempotent on (chain, txHash, logIndex)', async () => {
    deposits = [deposit()];
    await scanDeposits(options());
    const second = await scanDeposits(options());
    expect(second).toEqual({ recorded: 0, skipped: 1, deferred: 0 });
    expect((await store.getReserve('hkd'))?.reserveRaw).toBe(1_500_000n);
  });

  it('tracks dust when the external asset is finer than 6 decimals', async () => {
    // 1.234567890123456789 ETH at 18dp -> 1234567 at 6dp + dust
    deposits = [deposit({ assetId: 'eth', externalRaw: '1234567890123456789', txHash: '0xE1' })];
    const result = await scanDeposits(options());
    expect(result.recorded).toBe(1);
    const reserve = await store.getReserve('eth');
    expect(reserve?.reserveRaw).toBe(1_234_567n);
    expect(reserve?.dustRaw).toBe(890_123_456_789n);
  });

  it('skips unknown assets and sub-unit dust deposits', async () => {
    deposits = [
      deposit({ assetId: 'doge', txHash: '0xD' }),
      deposit({ assetId: 'eth', externalRaw: '1', txHash: '0xDust' }),
    ];
    expect(await scanDeposits(options())).toEqual({ recorded: 0, skipped: 2, deferred: 0 });
    expect(await store.getReserve('doge')).toBeUndefined();
  });
});

describe('redemption watcher', () => {
  it('records a finalized L1 transfer to the issuer as a pending withdrawal', async () => {
    redemptions = [{
      assetId: 'gold', account: 'w1', l1Raw: '2000000',
      chain: 'l1-order', txHash: '0xF1', logIndex: 0, blockNumber: 90,
    }];
    expect(await scanRedemptions(options())).toEqual({ recorded: 1, skipped: 0, deferred: 0 });
    const op = await store.findOperationByKey('l1-order:0xf1:0');
    expect(op?.kind).toBe('withdrawal');
    expect(op?.status).toBe('pending');
    // the watcher does not touch supply; the executor retires it on release
    expect(await store.getReserve('gold')).toBeUndefined();
  });

  it('defers a redemption above finality and ignores duplicates', async () => {
    redemptions = [{
      assetId: 'gold', account: 'w1', l1Raw: '1',
      chain: 'l1-order', txHash: '0xF2', logIndex: 0, blockNumber: 101,
    }];
    expect(await scanRedemptions(options())).toEqual({ recorded: 0, skipped: 0, deferred: 1 });

    redemptions = [{ ...redemptions[0], blockNumber: 100 }];
    await scanRedemptions(options());
    expect(await scanRedemptions(options())).toEqual({ recorded: 0, skipped: 1, deferred: 0 });
  });
});
