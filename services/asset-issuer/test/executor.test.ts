import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSETS } from '../src/config.js';
import type { Operation } from '../src/domain.js';
import { MemoryStore } from '../src/store.js';
import { requeue, runOnce, type ExecutorOptions } from '../src/executor.js';

let store: MemoryStore;
let tick = 0;
let mint: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
let transfer: ReturnType<typeof vi.fn>;

const options = (): ExecutorOptions => ({
  store,
  assets: DEFAULT_ASSETS,
  l1: { mint },
  treasury: { release },
  transfers: { transfer },
  now: () => `2026-01-01T00:00:0${tick++}.000Z`,
});

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1',
  kind: 'deposit',
  assetId: 'hkd',
  account: 'w1',
  amountRaw: '1000',
  l1AmountRaw: '1000',
  status: 'pending',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  store = new MemoryStore();
  tick = 0;
  mint = vi.fn(async () => ({ txHash: '0xmint' }));
  release = vi.fn(async () => ({ txHash: '0xrelease' }));
  transfer = vi.fn(async () => ({ txHash: '0xtransfer' }));
});

describe('mint execution', () => {
  it('mints against the reserve, then credits supply and the holder', async () => {
    await store.putReserve({ assetId: 'hkd', reserveRaw: 5000n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op());

    const result = await runOnce(options());
    expect(result).toEqual({ completed: 1, failed: 0, skipped: 0 });
    expect(mint).toHaveBeenCalledWith('hkd', 'w1', '1000');

    const reserve = await store.getReserve('hkd');
    expect(reserve?.supplyRaw).toBe(1000n);
    const balance = await store.getHolderBalance('hkd', 'w1');
    expect(balance?.availableRaw).toBe(1000n);
    expect((await store.getOperation('op1'))?.status).toBe('completed');
  });

  it('re-checks the invariant at execution time and fails an over-mint', async () => {
    // The HTTP check passed on an older snapshot; the reserve has since shrunk.
    await store.putReserve({ assetId: 'hkd', reserveRaw: 500n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op());

    const result = await runOnce(options());
    expect(result.failed).toBe(1);
    expect(mint).not.toHaveBeenCalled();
    const failed = await store.getOperation('op1');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('reserve');
  });

  it('fails the operation when the signer errors, and does not credit anything', async () => {
    mint.mockRejectedValueOnce(new Error('hsm unavailable'));
    await store.putReserve({ assetId: 'hkd', reserveRaw: 5000n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op());

    const result = await runOnce(options());
    expect(result.failed).toBe(1);
    expect((await store.getReserve('hkd'))?.supplyRaw).toBe(0n);
    expect((await store.getOperation('op1'))?.error).toBe('hsm unavailable');
  });

  it('never re-processes a completed operation', async () => {
    await store.putReserve({ assetId: 'hkd', reserveRaw: 5000n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op({ status: 'completed' }));
    expect(await runOnce(options())).toEqual({ completed: 0, failed: 0, skipped: 0 });
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('release execution', () => {
  it('releases the external asset and retires supply and reserve together', async () => {
    await store.putReserve({ assetId: 'gold', reserveRaw: 5000n, supplyRaw: 4000n, dustRaw: 0n });
    await store.putHolderBalance({ assetId: 'gold', account: 'w1', availableRaw: 0n, pendingRaw: 2000n });
    await store.saveOperation(op({ kind: 'withdrawal', assetId: 'gold', amountRaw: '2000', l1AmountRaw: '2000' }));

    const result = await runOnce(options());
    expect(result.completed).toBe(1);
    // gold is 6dp on both sides, so the external amount equals the L1 amount
    expect(release).toHaveBeenCalledWith('gold', 'w1', '2000');
    const reserve = await store.getReserve('gold');
    expect(reserve?.supplyRaw).toBe(2000n);
    expect(reserve?.reserveRaw).toBe(3000n);
    expect((await store.getHolderBalance('gold', 'w1'))?.pendingRaw).toBe(0n);
  });

  it('refuses an L1 amount that is not representable at the external scale', async () => {
    // eth is 18dp external; a 1-unit L1 amount is representable, so use a
    // synthetic asset whose external scale is coarser than L1.
    const assets = DEFAULT_ASSETS.map((a) =>
      a.assetId === 'hkd' ? { ...a, externalDecimals: 2, l1Decimals: 6 } : a);
    await store.putReserve({ assetId: 'hkd', reserveRaw: 2_000_000n, supplyRaw: 1_000_000n, dustRaw: 0n });
    await store.saveOperation(op({ kind: 'redeem', assetId: 'hkd', amountRaw: '1500001', l1AmountRaw: '1500001' }));

    const result = await runOnce({ ...options(), assets });
    expect(result.failed).toBe(1);
    expect(release).not.toHaveBeenCalled();
    expect((await store.getOperation('op1'))?.error).toContain('representable');
  });
});

describe('transfer execution', () => {
  it('calls the distributor and settles pending', async () => {
    await store.putHolderBalance({ assetId: 'hkd', account: 'w1', availableRaw: 0n, pendingRaw: 1000n });
    await store.saveOperation(op({ kind: 'transfer', externalRef: 'w2' }));
    expect((await runOnce(options())).completed).toBe(1);
    expect(transfer).toHaveBeenCalledWith('hkd', 'w1', 'w2', '1000');
    expect((await store.getHolderBalance('hkd', 'w1'))?.pendingRaw).toBe(0n);
  });
});

describe('requeue', () => {
  it('only requeues failed operations and preserves attempts', async () => {
    const now = () => '2026-01-02T00:00:00.000Z';
    await store.saveOperation(op({ status: 'failed', attempts: 3, error: 'boom' }));
    const next = await requeue(store, 'op1', now);
    expect(next.status).toBe('pending');
    expect(next.error).toBeUndefined();
    expect(next.attempts).toBe(3);
    await expect(requeue(store, 'op1', now)).rejects.toThrow(/only failed/);
  });
});
