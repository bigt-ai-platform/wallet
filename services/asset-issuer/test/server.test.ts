import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AssetConfig } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import { buildServer, advance } from '../src/server.js';
import { authFromEnv, signRequest } from '../src/auth.js';
import { PQKey, TestParams, Utils } from 'bigt-ai-ts';
import {
  REDEEM_INTENT_DOMAIN, intentHash, type RedeemIntent,
} from '../src/intent.js';

let app: FastifyInstance;
let appClosed = false;
let store: MemoryStore;
let tick = 0;

beforeEach(async () => {
  store = new MemoryStore();
  tick = 0;
  appClosed = false;
  app = buildServer({
    store,
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    newId: () => `op${tick}`,
    mintToken: 'mint-secret',
    verifyRedemption: async () => ({ status: 'ok', txHash: CANONICAL_L1_TX, logIndex: 3 }),
  });
});

afterEach(async () => {
  if (!appClosed) await app.close();
  appClosed = false;
});

const ACCOUNT = 'wallet-1';
/** What the verifier returns: canonical (no 0x) and the real output index. */
const CANONICAL_L1_TX = 'ab'.repeat(32);

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
  const mint = (payload: Record<string, unknown>, token = 'mint-secret') => app.inject({
    method: 'POST',
    url: '/mint-requests',
    payload,
    headers: { 'x-mint-token': token },
  });

  it('refuses a mint with no reserve credited', async () => {
    const res = await mint({ account: ACCOUNT, assetId: 'hkd', amount: '10' });
    expect(res.statusCode).toBe(409);
  });

  it('refuses the wallet bearer without the operator mint credential', async () => {
    await seedReserve('hkd', 100n, 0n);
    const body = { account: ACCOUNT, assetId: 'hkd', amount: '10' };
    // The wallet's public bearer must not reach mint authority.
    const bearerOnly = await app.inject({
      method: 'POST', url: '/mint-requests', payload: body,
      headers: { authorization: 'Bearer public-wallet-token' },
    });
    expect(bearerOnly.statusCode).toBe(403);
    expect((await mint(body, 'wrong')).statusCode).toBe(403);
  });

  it('refuses a mint above the reserve and accepts one within it', async () => {
    await seedReserve('hkd', 100n, 0n);
    const tooMuch = await mint({ account: ACCOUNT, assetId: 'hkd', amount: '101' });
    expect(tooMuch.statusCode).toBe(409);

    const ok = await mint({ account: ACCOUNT, assetId: 'hkd', amount: '100' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('pending');
  });

  it('does not debit supply at request time — only the executor does', async () => {
    await seedReserve('hkd', 100n, 0n);
    await mint({ account: ACCOUNT, assetId: 'hkd', amount: '100' });
    const reserve = await store.getReserve('hkd');
    expect(reserve?.supplyRaw).toBe(0n);
  });
});

describe('signed redeem intents', () => {
  const DESTINATION = '0x2222222222222222222222222222222222222222';
  const L1_TX = '0x' + 'ab'.repeat(32);
  const pq = PQKey.fromMLDSA(new Uint8Array(32).fill(9));
  const account = pq.toAddressString(new TestParams());

  const intent = (over: Partial<RedeemIntent> = {}): RedeemIntent => ({
    domain: REDEEM_INTENT_DOMAIN,
    network: 'Test',
    assetId: 'gold',
    account,
    amountRaw: '2000000',
    destination: DESTINATION,
    l1TxHash: L1_TX,
    nonce: 'nonce-0001',
    expiry: Date.now() + 60_000,
    ...over,
  });

  const body = (over: Record<string, unknown> = {}) => {
    const value = intent(over.intent as Partial<RedeemIntent> | undefined);
    return {
      account: value.account,
      assetId: value.assetId,
      amount: value.amountRaw,
      destination: value.destination,
      l1TxHash: value.l1TxHash,
      nonce: value.nonce,
      expiry: value.expiry,
      keyType: 'PQ',
      publicKey: pq.getPublicKeyAsHex(),
      signature: Utils.HEX.encode(pq.sign(intentHash(value)).serialize()),
      ...over.body,
    };
  };

  beforeEach(async () => {
    await store.putHolderBalance({
      assetId: 'gold', account, availableRaw: 50_000_000n, pendingRaw: 0n,
    });
  });

  it('verifies the L1 signature, binds the destination and debits the balance', async () => {
    const res = await app.inject({
      method: 'POST', url: '/redeem-intents', payload: body(),
    });
    expect(res.statusCode).toBe(200);

    const balance = await store.getHolderBalance('gold', account);
    expect(balance?.availableRaw).toBe(48_000_000n);
    expect(balance?.pendingRaw).toBe(2_000_000n);

    const { id } = res.json() as { id: string };
    const op = await store.getOperation(id);
    expect(op?.destination).toBe(DESTINATION);
    // The release is bound to the L1 return, not just to the signature.
    // The stored ref is the outpoint the verifier matched, not the client's
    // `0x` spelling or a hardcoded index 0.
    expect(op?.ref).toEqual({ chain: 'l1-order', txHash: CANONICAL_L1_TX, logIndex: 3 });
  });

  it('refuses a redemption whose L1 funding transfer is missing or unconfirmed', async () => {
    await rebuild({
      store,
      now: () => `2026-01-01T00:00:0${tick++}.000Z`,
      newId: () => `op${tick}`,
      verifyRedemption: async () => ({ status: 'pending' }),
    });
    const pending = await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() });
    expect(pending.statusCode).toBe(409);
    expect((pending.json() as { retryable?: boolean }).retryable).toBe(true);

    await rebuild({
      store,
      now: () => `2026-01-01T00:00:0${tick++}.000Z`,
      newId: () => `op${tick}`,
      verifyRedemption: async () => ({ status: 'invalid' }),
    });
    const invalid = await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() });
    expect(invalid.statusCode).toBe(409);
    // Nothing was reserved or debited.
    expect((await store.getHolderBalance('gold', account))?.pendingRaw).toBe(0n);
  });

  it('fails closed when L1 redemption verification is not configured', async () => {
    await rebuild({
      store,
      now: () => `2026-01-01T00:00:0${tick++}.000Z`,
      newId: () => `op${tick}`,
    });
    const res = await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() });
    expect(res.statusCode).toBe(503);
    expect((await store.getHolderBalance('gold', account))?.pendingRaw).toBe(0n);
  });

  it('refuses to reuse one L1 funding transfer for a second redemption', async () => {
    expect((await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() })).statusCode)
      .toBe(200);
    const second = await app.inject({
      method: 'POST', url: '/redeem-intents',
      payload: body({ intent: { nonce: 'nonce-0002' } }),
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects a replayed nonce', async () => {
    expect((await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() })).statusCode)
      .toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/redeem-intents', payload: body() });
    expect(replay.statusCode).toBe(409);
    expect((await store.getHolderBalance('gold', account))?.availableRaw).toBe(48_000_000n);
  });

  it('rejects a tampered amount, an expired intent and the unsigned route', async () => {
    const signed = body();
    const tampered = await app.inject({
      method: 'POST', url: '/redeem-intents', payload: { ...signed, amount: '1000000' },
    });
    expect(tampered.statusCode).toBe(401);

    const expired = await app.inject({
      method: 'POST', url: '/redeem-intents',
      payload: body({ intent: { nonce: 'nonce-0002', expiry: Date.now() - 1_000 } }),
    });
    expect(expired.statusCode).toBe(400);

    const unsigned = await app.inject({
      method: 'POST', url: '/redeem-requests',
      payload: { account, assetId: 'gold', amount: '2000000' },
    });
    expect(unsigned.statusCode).toBe(400);
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

  it('surfaces unsettled redeem refs stored at output index 0', async () => {
    await store.saveOperation({
      id: 'legacy-redeem',
      kind: 'redeem',
      assetId: 'gold',
      account: 'w1',
      amountRaw: '1',
      l1AmountRaw: '1',
      status: 'pending',
      ref: { chain: 'l1-order', txHash: 'legacy', logIndex: 0 },
      destination: '0x2222222222222222222222222222222222222222',
      attempts: 0,
      createdAt: 't',
      updatedAt: 't',
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect((res.json() as { legacyRedeemRefs: number }).legacyRedeemRefs).toBe(1);
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

const XPUB = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';

const usdt = (over: Partial<AssetConfig> = {}): AssetConfig => ({
  assetId: 'usdt',
  symbol: 'USDT',
  depositKind: 'evm',
  depositAddress: '0x5555555555555555555555555555555555555555',
  custodyAddress: '0x1111111111111111111111111111111111111111',
  depositAddressMode: 'per-user',
  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  l1TokenId: 'token',
  externalDecimals: 6,
  l1Decimals: 6,
  maxSupplyRaw: 10n ** 18n,
  maxMintRaw: 10n ** 12n,
  enabled: true,
  ...over,
});

async function rebuild(options: Parameters<typeof buildServer>[0]): Promise<void> {
  if (!appClosed) {
    await app.close();
    appClosed = true;
  }
  app = buildServer(options);
  appClosed = false;
}

describe('deposit page endpoints', () => {
  it('publishes the canonical L1 token id and the redemption address', async () => {
    await rebuild({
      store,
      assets: [usdt({ redemptionAddress: 'REDEEM-ADDR' })],
      defaultDepositAssetId: 'usdt',
    });
    const res = await app.inject({ method: 'GET', url: '/assets' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
      assetId: 'usdt',
      l1TokenId: 'token',
      redemptionAddress: 'REDEEM-ADDR',
    });
  });

  it('returns the static custody address when the asset is not per-user', async () => {
    await rebuild({
      store,
      assets: [usdt({ depositAddressMode: 'static', depositAddress: '0x5555555555555555555555555555555555555555' })],
      defaultDepositAssetId: 'usdt',
    });

    const res = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-1' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { address: string }).address).toBe('0x5555555555555555555555555555555555555555');
  });

  it('allocates one stable per-user address per L1 account', async () => {
    await rebuild({ store, assets: [usdt()], depositXpub: XPUB, defaultDepositAssetId: 'usdt' });

    const first = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-1' });
    const again = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-1' });
    const other = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-2' });

    expect(first.statusCode).toBe(200);
    const a = (first.json() as { address: string }).address;
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((again.json() as { address: string }).address).toBe(a);
    expect((other.json() as { address: string }).address).not.toBe(a);

    expect(await store.findAccountByDepositAddress('usdt', a)).toBe('l1-1');
  });

  it('reports a derivation failure instead of returning a wrong address', async () => {
    await rebuild({ store, assets: [usdt()], depositXpub: 'xpub-not-a-key', defaultDepositAssetId: 'usdt' });
    const res = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-1' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toMatch(/derivation failed/);
    expect(await store.listDepositAddresses('usdt')).toHaveLength(0);
  });

  it('fails closed when per-user is requested without an xpub', async () => {
    await rebuild({ store, assets: [usdt()], defaultDepositAssetId: 'usdt' });
    const res = await app.inject({ method: 'GET', url: '/deposit-address?account=l1-1' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toMatch(/DEPOSIT_XPUB/);
    expect(await store.listDepositAddresses('usdt')).toHaveLength(0);
  });

  it('maps deposit operations to the page status and display units', async () => {
    await rebuild({ store, assets: [usdt()], defaultDepositAssetId: 'usdt' });

    await store.saveOperation({
      id: 'op-credited',
      kind: 'deposit',
      assetId: 'usdt',
      account: 'l1-1',
      amountRaw: '100000000',
      l1AmountRaw: '100000000',
      status: 'completed',
      ref: { chain: 'ethereum', txHash: '0xAAA', logIndex: 0 },
      attempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
    });
    await store.saveOperation({
      id: 'op-failed',
      kind: 'deposit',
      assetId: 'usdt',
      account: 'l1-1',
      amountRaw: '2000000',
      l1AmountRaw: '2000000',
      status: 'failed',
      ref: { chain: 'ethereum', txHash: '0xBBB', logIndex: 1 },
      attempts: 1,
      createdAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    });
    // A mint is the executor's step, not a user-visible deposit row.
    await store.saveOperation({
      id: 'op-mint',
      kind: 'mint',
      assetId: 'usdt',
      account: 'l1-1',
      amountRaw: '100000000',
      l1AmountRaw: '100000000',
      status: 'completed',
      attempts: 1,
      createdAt: '2026-01-01T00:06:00.000Z',
      updatedAt: '2026-01-01T00:06:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/deposits?account=l1-1&assetId=usdt' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ hash: string; amount: string; status: string; creditedAt?: string }>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      hash: '0xBBB', amount: '2', status: 'failed',
    });
    expect(body.items[1]).toEqual({
      hash: '0xAAA', amount: '100', status: 'credited', creditedAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('returns an empty list for an account with no deposits', async () => {
    await rebuild({ store, assets: [usdt()], defaultDepositAssetId: 'usdt' });
    const res = await app.inject({ method: 'GET', url: '/deposits?account=nobody' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });
});

describe('authentication', () => {
  it('requires a bearer token on every route except /health', async () => {
    await rebuild({ store, auth: authFromEnv({ AUTH_MODE: 'bearer', API_TOKEN: 'secret' }) });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const denied = await app.inject({ method: 'GET', url: `/balances?account=${ACCOUNT}` });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: 'GET',
      url: `/balances?account=${ACCOUNT}`,
      headers: { authorization: 'Bearer secret' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('binds an HMAC request to the account and rejects a tampered body', async () => {
    const auth = authFromEnv({ AUTH_MODE: 'hmac', API_HMAC_SECRET: 'hmac-secret' });
    await rebuild({ store, auth });

    const timestamp = String(Date.now());
    const body = { account: ACCOUNT, assetId: 'hkd', to: 'wallet-2', amount: '10' };
    const signature = signRequest('hmac-secret', {
      method: 'POST', path: '/transfers', account: ACCOUNT, timestamp, body,
    });
    await seedBalance('hkd', 100n);

    const denied = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: { ...body, account: 'wallet-2' },
      headers: {
        'x-account': ACCOUNT,
        'x-timestamp': timestamp,
        'x-signature': signRequest('hmac-secret', {
          method: 'POST', path: '/transfers', account: 'wallet-2', timestamp,
          body: { ...body, account: 'wallet-2' },
        }),
      },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: body,
      headers: { 'x-account': ACCOUNT, 'x-timestamp': timestamp, 'x-signature': signature },
    });
    expect(allowed.statusCode).toBe(200);
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
