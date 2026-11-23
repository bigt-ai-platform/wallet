import { describe, expect, it } from 'vitest';
import { planSweeps, type SweepCandidate } from '../src/sweep.js';

const OMNIBUS = '0x1111111111111111111111111111111111111111';

const candidate = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
  assetId: 'usdt',
  account: 'l1-1',
  address: '0x2222222222222222222222222222222222222222',
  addressIndex: 0,
  tokenBalanceRaw: 100_000_000n,
  nativeBalanceWei: 10n ** 17n,
  gasLimit: 65_000n,
  ...over,
});

const options = (over: Record<string, unknown> = {}) => ({
  omnibus: OMNIBUS,
  minTokenRaw: 20_000_000n,
  maxFeePerGasWei: 10_000_000_000n,
  nativeReserveWei: 0n,
  ...over,
});

describe('sweep planning', () => {
  it('sweeps a balance above the threshold with enough gas', () => {
    const plan = planSweeps([candidate()], options());
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toMatchObject({
      address: '0x2222222222222222222222222222222222222222',
      amountRaw: 100_000_000n,
      gasLimit: 65_000n,
    });
    expect(plan.skipped).toEqual([]);
  });

  it('explains every skip instead of silently dropping it', () => {
    const plan = planSweeps([
      candidate({ address: OMNIBUS }),
      candidate({ address: '0x3333333333333333333333333333333333333333', tokenBalanceRaw: 0n }),
      candidate({ address: '0x4444444444444444444444444444444444444444', tokenBalanceRaw: 1_000_000n }),
      candidate({
        address: '0x5555555555555555555555555555555555555555',
        nativeBalanceWei: 65_000n * 10_000_000_000n - 1n,
      }),
    ], options());

    expect(plan.jobs).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['omnibus', 'zero', 'below-min', 'no-gas']);
  });

  it('includes the exact gas cost in the affordability check', () => {
    const exact = 65_000n * 10_000_000_000n + 5n;
    const ok = planSweeps([candidate({ nativeBalanceWei: exact })], options({ nativeReserveWei: 5n }));
    expect(ok.jobs).toHaveLength(1);

    const short = planSweeps([candidate({ nativeBalanceWei: exact - 1n })], options({ nativeReserveWei: 5n }));
    expect(short.skipped[0]?.reason).toBe('no-gas');
  });

  it('orders jobs by allocation index (stable for batch nonces)', () => {
    const plan = planSweeps([
      candidate({ address: '0x6666666666666666666666666666666666666666', addressIndex: 2 }),
      candidate({ address: '0x7777777777777777777777777777777777777777', addressIndex: 0 }),
    ], options());
    expect(plan.jobs.map((j) => j.addressIndex)).toEqual([0, 2]);
  });
});
