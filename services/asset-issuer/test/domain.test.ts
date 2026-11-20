import { describe, expect, it } from 'vitest';
import {
  TransitionError,
  canMint,
  canTransition,
  chainKey,
  isFinalized,
  reconcile,
  supplyWithinReserve,
  toL1Amount,
  transition,
  withinCaps,
  type Operation,
  type ReserveEntry,
} from '../src/domain.js';

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1',
  kind: 'deposit',
  assetId: 'hkd',
  account: 'u1',
  amountRaw: '1000',
  l1AmountRaw: '1000',
  status: 'pending',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const entry = (over: Partial<ReserveEntry> = {}): ReserveEntry => ({
  assetId: 'hkd',
  reserveRaw: 1000n,
  supplyRaw: 0n,
  dustRaw: 0n,
  ...over,
});

describe('operation state machine', () => {
  it('allows the forward edges and refuses skips', () => {
    expect(canTransition('pending', 'processing')).toBe(true);
    expect(canTransition('processing', 'completed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('completed', 'processing')).toBe(false);
  });

  it('makes completed terminal and never lets a completion be undone', () => {
    expect(canTransition('completed', 'failed')).toBe(false);
    expect(canTransition('completed', 'pending')).toBe(false);
    expect(() => transition(op({ status: 'completed' }), 'pending', 'now')).toThrow(TransitionError);
  });

  it('counts attempts on processing and clears the error on retry', () => {
    const failed = transition(op({ error: 'boom', attempts: 2 }), 'failed', 't1', 'rpc down');
    expect(failed.error).toBe('rpc down');
    expect(failed.attempts).toBe(2);
    const retried = transition(failed, 'pending', 't2');
    expect(retried.error).toBeUndefined();
    expect(retried.attempts).toBe(2);
    const processing = transition(retried, 'processing', 't3');
    expect(processing.attempts).toBe(3);
  });

  it('requires an explicit failed -> pending requeue', () => {
    expect(canTransition('failed', 'pending')).toBe(true);
    expect(canTransition('failed', 'processing')).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('is stable and case-normalises the hash', () => {
    expect(chainKey({ chain: 'ethereum', txHash: '0xAB', logIndex: 3 })).toBe('ethereum:0xab:3');
    expect(chainKey({ chain: 'ethereum', txHash: '0xab', logIndex: 3 }))
      .toBe(chainKey({ chain: 'ethereum', txHash: '0xAB', logIndex: 3 }));
  });

  it('refuses an incomplete or malformed observation', () => {
    expect(() => chainKey({ chain: '', txHash: '0x1', logIndex: 0 })).toThrow();
    expect(() => chainKey({ chain: 'eth', txHash: '', logIndex: 0 })).toThrow();
    expect(() => chainKey({ chain: 'eth', txHash: '0x1', logIndex: -1 })).toThrow();
    expect(() => chainKey({ chain: 'eth', txHash: '0x1', logIndex: 1.5 })).toThrow();
  });
});

describe('finality gate', () => {
  it('only accepts an observation at or below the finalized block', () => {
    expect(isFinalized(100, 100)).toBe(true);
    expect(isFinalized(100, 99)).toBe(true);
    expect(isFinalized(100, 101)).toBe(false);
    expect(isFinalized(Number.NaN, 1)).toBe(false);
  });
});

describe('external -> L1 conversion', () => {
  it('scales up when the L1 has more decimals', () => {
    expect(toL1Amount('5', 2, 6)).toEqual({ l1: 50000n, dust: 0n });
  });

  it('floors and reports dust when the external side is finer (ETH 18 -> 6)', () => {
    // 1.234567890123456789 ETH -> 6 decimals, remainder is dust.
    expect(toL1Amount('1234567890123456789', 18, 6)).toEqual({ l1: 1234567n, dust: 890123456789n });
  });

  it('never loses value silently: l1 + dust reconstructs the input', () => {
    const { l1, dust } = toL1Amount('1234567890123456789', 18, 6);
    expect(l1 * 10n ** 12n + dust).toBe(1234567890123456789n);
  });

  it('rejects negative and non-numeric amounts', () => {
    expect(() => toL1Amount('-1', 6, 6)).toThrow();
    expect(() => toL1Amount('abc', 6, 6)).toThrow();
  });
});

describe('reserve invariant', () => {
  it('holds at equality and fails on any overflow', () => {
    expect(supplyWithinReserve(entry({ supplyRaw: 1000n }))).toBe(true);
    expect(supplyWithinReserve(entry({ supplyRaw: 1001n }))).toBe(false);
  });

  it('refuses a mint that would exceed the reserve', () => {
    expect(canMint(entry({ reserveRaw: 1000n, supplyRaw: 900n }), 100n)).toBe(true);
    expect(canMint(entry({ reserveRaw: 1000n, supplyRaw: 900n }), 101n)).toBe(false);
    expect(canMint(entry(), 0n)).toBe(false);
  });

  it('applies per-operation and total caps independently', () => {
    const caps = { maxSupplyRaw: 5000n, maxMintRaw: 100n };
    expect(withinCaps(entry({ supplyRaw: 0n }), 100n, caps)).toBe(true);
    expect(withinCaps(entry({ supplyRaw: 0n }), 101n, caps)).toBe(false);
    expect(withinCaps(entry({ supplyRaw: 4950n }), 100n, caps)).toBe(false);
  });

  it('reconciles per asset and reports the overflow, never a bare boolean', () => {
    const breaches = reconcile([
      entry({ assetId: 'hkd', reserveRaw: 100n, supplyRaw: 100n }),
      entry({ assetId: 'usd', reserveRaw: 100n, supplyRaw: 120n }),
      entry({ assetId: 'gold', reserveRaw: 0n, supplyRaw: 1n }),
    ]);
    expect(breaches).toEqual([
      { assetId: 'usd', supplyRaw: '120', reserveRaw: '100', overflowRaw: '20' },
      { assetId: 'gold', supplyRaw: '1', reserveRaw: '0', overflowRaw: '1' },
    ]);
  });
});
