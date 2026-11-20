import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryStore } from '../src/store.js';
import { buildServer, advance } from '../src/server.js';

let app: FastifyInstance;
let store: MemoryStore;
let tick = 0;

beforeEach(async () => {
  store = new MemoryStore();
  tick = 0;
  app = buildServer({
    store,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    newId: () => `op${tick}`,
  });
});

afterEach(async () => {
  await app.close();
});

const ACCOUNT = 'wallet-1';

function seedBalance(assetId: string, available: bigint) {
  return store.putHolderBalance({ assetId, account: ACCOUNT, availableRaw: available, pendingRaw: 0n });
}

function seedReserve(assetId: string, reserve: bigint, supply: bigint) {
  return store.putReserve({ assetId, reserveRaw: reserve, supplyRaw: supply, dustRaw: 0n });
}

describe('discovery endpoints', () => {
  it('lists the enabled assets with their L1 decimals', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ assetId: string; decimals: number; depositKind: string; depositInstructions?: string; referencePrefix?: string }>;
    };
    expect(body.items.map((i) => i.assetId)).toEqual(['hkd', 'usd', 'gold', 'eth']);
    expect(body.items.every((i) => i.decimals === 6)).toBe(true);
    // the funding rail travels with the listing so the wallet never hardcodes it
    expect(body.items.map((i) => i.depositKind)).toEqual(['bank', 'bank', 'vault', 'evm']);
    expect(body.items[0].depositInstructions).toBeTruthy();
    expect(body.items[0].referencePrefix).toBe('HKD');
  });

  it('requires an account for balances and treats unknown assets as zero', async () => {
    const missing = await app.inject({ method: 'GET', url: '/balances' });
    expect(missing.statusCode).toBe(400);

    const res = await app.inject({ method: 'GET', url: `/balances?account=${ACCOUNT}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ available: string }> };
    expect(body.items).toHaveLength(4);
    expect(body.items.every((i) => i.available === '0')).toBe(true);
  });

  it('returns an empty statement for an account with no operations', async () => {
    const res = await app.inject({ method: 'GET', url: `/statement?account=${ACCOUNT}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });
});

describe('transfers', () => {
  it('refuses an unknown asset and a non-numeric amount', async () => {
    const unknown = await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'doge', to: 'x', amount: '10' },
    });
    expect(unknown.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'hkd', to: 'x', amount: '1.5' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses a transfer without balance and moves the balance when there is one', async () => {
    const broke = await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10' },
    });
    expect(broke.statusCode).toBe(409);

    await seedBalance('hkd', 100n);
    const ok = await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10' },
    });
    expect(ok.statusCode).toBe(200);
    const { id, status } = ok.json() as { id: string; status: string };
    expect(status).toBe('pending');

    const balance = await store.getHolderBalance('hkd', ACCOUNT);
    expect(balance?.availableRaw).toBe(90n);
    expect(balance?.pendingRaw).toBe(10n);

    const polled = await app.inject({ method: 'GET', url: `/transfers/${id}` });
    expect(polled.statusCode).toBe(200);
    expect((polled.json() as { status: string }).status).toBe('pending');
  });

  it('is idempotent when the client supplies a key', async () => {
    await seedBalance('hkd', 100n);
    const body = {
      account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10', idempotencyKey: 'req-1',
    };
    const first = await app.inject({ method: 'POST', url: '/transfers', payload: body });
    const second = await app.inject({ method: 'POST', url: '/transfers', payload: body });
    // The second call does not debit again.
    const balance = await store.getHolderBalance('hkd', ACCOUNT);
    expect(balance?.pendingRaw).toBe(10n);
    expect((first.json() as { id: string }).id).toBeDefined();
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
  });
});

describe('mint requests', () => {
  it('refuses a mint with no reserve credited', async () => {
    const res = await app.inject({
      method: 'POST', url: '/mint-requests',
      payload: { account: ACCOUNT, assetId: 'hkd', amount: '10' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a mint above the reserve and accepts one within it', async () => {
    await seedReserve('hkd', 100n, 0n);
    const tooMuch = await app.inject({
      method: 'POST', url: '/mint-requests',
      payload: { account: ACCOUNT, assetId: 'hkd', amount: '101' },
    });
    expect(tooMuch.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'POST', url: '/mint-requests',
      payload: { account: ACCOUNT, assetId: 'hkd', amount: '100' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('pending');
  });

  it('does not debit supply at request time — only the executor does', async () => {
    await seedReserve('hkd', 100n, 0n);
    await app.inject({
      method: 'POST', url: '/mint-requests',
      payload: { account: ACCOUNT, assetId: 'hkd', amount: '100' },
    });
    const reserve = await store.getReserve('hkd');
    expect(reserve?.supplyRaw).toBe(0n);
  });
});

describe('redeem requests', () => {
  it('requires balance and debits it into pending', async () => {
    await seedBalance('gold', 50n);
    const res = await app.inject({
      method: 'POST', url: '/redeem-requests',
      payload: { account: ACCOUNT, assetId: 'gold', amount: '20' },
    });
    expect(res.statusCode).toBe(200);
    const balance = await store.getHolderBalance('gold', ACCOUNT);
    expect(balance?.availableRaw).toBe(30n);
    expect(balance?.pendingRaw).toBe(20n);
  });
});

describe('statement and health', () => {
  it('maps operations to in/out movements with the L1 amount', async () => {
    await seedBalance('hkd', 100n);
    await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10' },
    });
    const res = await app.inject({ method: 'GET', url: `/statement?account=${ACCOUNT}` });
    const body = res.json() as { items: Array<{ direction: string; amount: string; status: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ direction: 'out', amount: '10', status: 'pending' });
  });

  it('reports unhealthy when supply exceeds reserve, per asset', async () => {
    await seedReserve('hkd', 100n, 100n);
    await seedReserve('usd', 100n, 101n);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; breaches: Array<{ assetId: string }> };
    expect(body.ok).toBe(false);
    expect(body.breaches).toEqual([
      { assetId: 'usd', supplyRaw: '101', reserveRaw: '100', overflowRaw: '1' },
    ]);
  });

  it('is healthy with no reserves at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe('executor transitions', () => {
  it('advances an operation and refuses to undo a completed one', async () => {
    await seedBalance('hkd', 100n);
    const created = await app.inject({
      method: 'POST', url: '/transfers',
      payload: { account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10' },
    });
    const { id } = created.json() as { id: string };

    await advance(store, id, 'processing');
    const done = await advance(store, id, 'completed');
    expect(done.status).toBe('completed');
    await expect(advance(store, id, 'pending')).rejects.toThrow(/illegal operation transition/);
  });
});
