import { describe, expect, it } from 'vitest';
import type { Operation } from '../src/domain.js';
import { MemoryStore, type RedeemIntentRecord } from '../src/store.js';

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1',
  kind: 'redeem',
  assetId: 'usdt',
  account: 'w1',
  amountRaw: '1000',
  l1AmountRaw: '1000',
  status: 'pending',
  ref: { chain: 'l1-order', txHash: '0xabc', logIndex: 0 },
  destination: '0x2222222222222222222222222222222222222222',
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const record = (over: Partial<RedeemIntentRecord> = {}): RedeemIntentRecord => ({
  assetId: 'usdt',
  account: 'w1',
  nonce: 'nonce-0001',
  intentHash: 'hash-1',
  destination: '0x2222222222222222222222222222222222222222',
  amountRaw: '1000',
  expiry: 1_800_000_000_000,
  operationId: 'op1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('redeem request reservation', () => {
  it('reserves the nonce, hash, L1 funding ref and operation in one call', async () => {
    const store = new MemoryStore();
    expect(await store.putRedeemRequest(record(), op(), 1000n)).toEqual({ ok: true, debited: false });
    expect(await store.getOperation('op1')).toBeDefined();
    // Same nonce is a replay.
    expect(await store.putRedeemRequest(record(), op({ id: 'op2' }), 1000n))
      .toEqual({ ok: false, reason: 'replay' });
    // A different nonce over the same L1 funding output is a replay too.
    expect(await store.putRedeemRequest(
      record({ nonce: 'nonce-0002', intentHash: 'hash-2' }),
      op({ id: 'op3' }),
      1000n,
    )).toEqual({ ok: false, reason: 'replay' });
  });

  it('debits a balance only when it covers the amount', async () => {
    const store = new MemoryStore();
    await store.putHolderBalance({
      assetId: 'usdt', account: 'w1', availableRaw: 1500n, pendingRaw: 0n,
    });
    expect(await store.putRedeemRequest(record(), op(), 1000n)).toEqual({ ok: true, debited: true });
    let balance = await store.getHolderBalance('usdt', 'w1');
    expect(balance?.availableRaw).toBe(500n);
    expect(balance?.pendingRaw).toBe(1000n);

    // A holder who bought the token on-market has no issuer balance; the L1
    // funding is still the authorization, so the request succeeds un-debited.
    const second = new MemoryStore();
    expect(await second.putRedeemRequest(record(), op(), 1000n)).toEqual({ ok: true, debited: false });
    balance = await second.getHolderBalance('usdt', 'w1');
    expect(balance).toBeUndefined();
  });
});

describe('mint capacity reservations', () => {
  it('serializes headroom and is idempotent per operation', async () => {
    const store = new MemoryStore();
    await store.putReserve({ assetId: 'usdt', reserveRaw: 1000n, supplyRaw: 0n, dustRaw: 0n });
    const caps = { maxSupplyRaw: 1000n, maxMintRaw: 1000n };

    expect(await store.reserveMint('a', 'usdt', 600n, caps)).toBe('reserved');
    // A requeue keeps its slot instead of double-counting it.
    expect(await store.reserveMint('a', 'usdt', 600n, caps)).toBe('reserved');
    expect(await store.reserveMint('b', 'usdt', 500n, caps)).toBe('exceeds');
    expect(await store.reserveMint('c', 'usdt', 400n, caps)).toBe('reserved');
    expect(await store.reserveMint('d', 'usdt', 1n, caps)).toBe('exceeds');

    // Releasing a reservation returns its headroom.
    await store.releaseMintReservation('a');
    expect(await store.reserveMint('d', 'usdt', 600n, caps)).toBe('reserved');
    expect(await store.reserveMint('e', 'usdt', 1n, caps)).toBe('exceeds');
  });

  it('consumes the reservation on settlement, not before', async () => {
    const store = new MemoryStore();
    await store.putReserve({ assetId: 'usdt', reserveRaw: 1000n, supplyRaw: 0n, dustRaw: 0n });
    const caps = { maxSupplyRaw: 1000n, maxMintRaw: 1000n };
    await store.saveOperation(op({ id: 'a', kind: 'deposit' }));
    expect(await store.reserveMint('a', 'usdt', 600n, caps)).toBe('reserved');

    await store.settleOperation(
      op({ id: 'a', kind: 'deposit', status: 'completed' }),
      { kind: 'mint', amountRaw: 600n },
    );
    expect((await store.getReserve('usdt'))?.supplyRaw).toBe(600n);
    // Settled supply now backs the slot; 400 is the only headroom left.
    expect(await store.reserveMint('b', 'usdt', 400n, caps)).toBe('reserved');
    expect(await store.reserveMint('c', 'usdt', 1n, caps)).toBe('exceeds');
  });

  it('enforces the per-operation and total-supply caps', async () => {
    const store = new MemoryStore();
    await store.putReserve({ assetId: 'usdt', reserveRaw: 10_000n, supplyRaw: 0n, dustRaw: 0n });
    const caps = { maxSupplyRaw: 1500n, maxMintRaw: 1000n };
    expect(await store.reserveMint('a', 'usdt', 1001n, caps)).toBe('exceeds');
    expect(await store.reserveMint('a', 'usdt', 1000n, caps)).toBe('reserved');
    expect(await store.reserveMint('b', 'usdt', 501n, caps)).toBe('exceeds');
    expect(await store.reserveMint('b', 'usdt', 500n, caps)).toBe('reserved');
  });
});

describe('settlement', () => {
  it('applies the ledger effect once and ignores a replay', async () => {
    const store = new MemoryStore();
    await store.putReserve({ assetId: 'usdt', reserveRaw: 5000n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op({ id: 'dep', kind: 'deposit' }));

    const completed = op({ id: 'dep', kind: 'deposit', status: 'completed' });
    expect(await store.settleOperation(completed, { kind: 'mint', amountRaw: 1000n })).toBe(true);
    expect((await store.getReserve('usdt'))?.supplyRaw).toBe(1000n);
    expect((await store.getHolderBalance('usdt', 'w1'))?.availableRaw).toBe(1000n);

    // A duplicate settlement must not add supply or balance again.
    expect(await store.settleOperation(completed, { kind: 'mint', amountRaw: 1000n })).toBe(false);
    expect((await store.getReserve('usdt'))?.supplyRaw).toBe(1000n);
    expect((await store.getHolderBalance('usdt', 'w1'))?.availableRaw).toBe(1000n);
  });

  it('refuses a mint beyond the reserve', async () => {
    const store = new MemoryStore();
    await store.putReserve({ assetId: 'usdt', reserveRaw: 500n, supplyRaw: 0n, dustRaw: 0n });
    await store.saveOperation(op({ id: 'dep', kind: 'deposit' }));
    await expect(store.settleOperation(
      op({ id: 'dep', kind: 'deposit', status: 'completed' }),
      { kind: 'mint', amountRaw: 1000n },
    )).rejects.toThrow(/reserve/);
    expect((await store.getReserve('usdt'))?.supplyRaw).toBe(0n);
  });
});
