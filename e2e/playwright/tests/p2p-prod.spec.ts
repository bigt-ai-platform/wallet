import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clickTab } from '../helpers';

/**
 * P2P against the DEPLOYED production stack (docs/p2p.md).
 *
 * Unlike the other p2p specs this starts nothing: it targets the chain nodes
 * deployed by `../blockchain/helper/prod/prod*.sh` and the live settlement
 * engine, so it proves the production wiring rather than a local harness.
 *
 *   L0 (prod.sh)         escrow chain / tx status       E2E_PROD_L0_URL
 *   L1-SOCIAL (prod-social.sh) seller order anchors      E2E_PROD_L1_SOCIAL_URL
 *   L1-order (prod-order.sh)  chain liveness             E2E_PROD_L1_ORDER_URL
 *   p2p engine           engine + chain projection       E2E_PROD_P2P_URL
 *   deployed wallet web  browser smoke                   E2E_PROD_WALLET_URL
 *
 * The default suite is READ-ONLY: chain health, engine capabilities/watch
 * health, the public book (PII-free, txids CONFIRMED on L1-SOCIAL), and an
 * independent chain replay compared with the engine's anchored book.
 *
 * Two opt-in write layers, because prod carries real funds/data:
 *   E2E_PROD_P2P_WRITE=1  legacy engine-intake order (create/cancel) and the
 *                         fail-closed txid/auth paths; no chain tx, no funds.
 *   E2E_PROD_P2P_SEED=<funded ML-DSA seed>  the real seller-anchored path:
 *                         anchor social.p2p-order on prod L1-SOCIAL, intake it,
 *                         cancel on chain. Spends the seller's BIG for fees.
 *
 * Wired as `./e2e/e2etest.sh p2p-prod` (the part sets E2E_PROD_P2P=1).
 * Skipped everywhere else so `all`/`remaining` never touch production.
 */
const ready = process.env.E2E_PROD_P2P === '1';
const write = process.env.E2E_PROD_P2P_WRITE === '1';
const sellerSeed = process.env.E2E_PROD_P2P_SEED || '';

const L0 = (process.env.E2E_PROD_L0_URL || 'https://eu1.bigtangle.org').replace(/\/+$/, '');
const SOCIAL = (process.env.E2E_PROD_L1_SOCIAL_URL || 'https://socialeu1.bigtangle.org').replace(/\/+$/, '');
const ORDER = (process.env.E2E_PROD_L1_ORDER_URL || 'https://ordereu1.bigtangle.org').replace(/\/+$/, '');
const ENGINE = (process.env.E2E_PROD_P2P_URL || 'https://eu.wallet.bigt.ai/p2p').replace(/\/+$/, '');
const WALLET = (process.env.E2E_PROD_WALLET_URL || '').replace(/\/+$/, '');

const HELPER = path.join(process.cwd(), 'p2p-order-chain.mjs');
const OUTDIR = path.join(process.cwd(), 'test-results');
fs.mkdirSync(OUTDIR, { recursive: true });

const TXID = /^[0-9a-f]{64}$/i;
const ORDER_ID = /^ord-[0-9a-f]{16}$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const RAILS = ['wechat', 'alipay', 'bank'];

type ChainTips = { height: number; prevBlockHash: string };

async function chainPost(request: APIRequestContext, base: string, cmd: string, data: unknown) {
  const res = await request.post(`${base}/${cmd}`, { data, timeout: 30_000 });
  return { status: res.status(), body: await res.json().catch(() => ({}) as Record<string, any>) };
}

async function chainTips(request: APIRequestContext, base: string): Promise<ChainTips> {
  const res = await chainPost(request, base, 'getTips', {});
  expect(res.status, `${base}/getTips`).toBe(200);
  const raw = res.body.text ?? res.body.message;
  expect(typeof raw, `${base}/getTips payload`).toBe('string');
  const tips = JSON.parse(raw) as ChainTips;
  expect(typeof tips.height).toBe('number');
  expect(tips.height).toBeGreaterThan(0);
  expect(tips.prevBlockHash).toMatch(TXID);
  return tips;
}

async function engineGet(request: APIRequestContext, route: string) {
  const res = await request.get(`${ENGINE}${route}`, { timeout: 30_000 });
  return { status: res.status(), body: await res.json().catch(() => ({}) as Record<string, any>) };
}

async function publicOrders(request: APIRequestContext, status: string) {
  const res = await engineGet(request, `/public/orders?status=${status}`);
  expect(res.status, `GET /public/orders?status=${status}`).toBe(200);
  expect(Array.isArray(res.body.orders)).toBe(true);
  return res.body.orders as Record<string, any>[];
}

/** Decimal-string comparison without floating point. */
function dec(s: string): bigint {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

function validateOrder(order: Record<string, any>, status: string) {
  expect(order.orderId).toMatch(ORDER_ID);
  expect(order.status).toBe(status);
  expect(order.sellerDid).toMatch(/^did:key:z/);
  expect(['limit_sell', 'limit_buy']).toContain(order.type);
  for (const field of ['giveToken', 'giveAmount', 'giveChain', 'wantCurrency', 'wantAmount', 'wantRail']) {
    expect(typeof order[field], `${order.orderId}.${field}`).toBe('string');
    expect(order[field].length).toBeGreaterThan(0);
  }
  expect(order.giveAmount).toMatch(DECIMAL);
  expect(order.wantAmount).toMatch(DECIMAL);
  expect(RAILS).toContain(order.wantRail);
  expect(order.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
  if (order.remainingGive !== undefined) {
    expect(order.remainingGive).toMatch(DECIMAL);
    expect(dec(order.remainingGive)).toBeLessThanOrEqual(dec(order.giveAmount));
  }
  if (order.wantRails !== undefined) {
    expect(Array.isArray(order.wantRails)).toBe(true);
    for (const rail of order.wantRails) expect(RAILS).toContain(rail);
  }
  // §14: the public book is PII-free — no signature, no receive address.
  expect(order).not.toHaveProperty('signature');
  expect(order).not.toHaveProperty('buyerReceiveAddress');
  expect(order.sellerReputation).toBeTruthy();
  expect(['new', 'established', 'trusted']).toContain(order.sellerReputation.tier);
}

/** Full L1-SOCIAL replay with the repo's own projector (docs/p2p.md §14). */
async function replayChain() {
  const { HttpSocialSource, syncOnce, MemCursorStore } = await import(
    '../../../services/p2p-engine/dist/replay.js'
  );
  const { MemSettlementStore } = await import('../../../services/p2p-engine/dist/store.js');
  const src = new HttpSocialSource(SOCIAL);
  const store = new MemSettlementStore();
  const result = await syncOnce(src, store, new MemCursorStore(), { maxWalk: 100_000 });
  const orders: Array<{ orderId: string; status: string; txid?: string; sellerDid: string }> = [];
  for (const status of ['ACTIVE', 'MATCHED', 'CANCELLED']) {
    for (const order of await store.listOrders(status)) {
      orders.push({ orderId: order.orderId, status: order.status, txid: order.txid, sellerDid: order.sellerDid });
    }
  }
  return { ...result, orders, head: await src.head() };
}

/** Authenticated engine envelope (did + nonce + timestamp + PQ signature). */
async function signBody(seed: string, fields: Record<string, unknown>) {
  const { PQKey } = await import('../../../packages/bigtangle-ts/dist/index.js');
  const { didFromPQKey, signChallengePQ } = await import('../../../packages/did/dist/pq.js');
  const { canonicalJson } = await import('../../../services/p2p-engine/dist/sign.js');
  const key = PQKey.fromPrivateKeyHex(seed);
  const did = didFromPQKey(key);
  const payload = { ...fields, did, nonce: randomBytes(16).toString('hex'), timestamp: Date.now() };
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return { did, body: { ...payload, signature: signChallengePQ(key, digest) } };
}

async function freshSeed(): Promise<string> {
  const { PQKey } = await import('../../../packages/bigtangle-ts/dist/index.js');
  const seed = PQKey.createNew().getPrivateKeySeedAsHex();
  if (!seed) throw new Error('PQKey did not expose a private seed');
  return seed as string;
}

/** Run the chain fixture without ever putting the prod seed on argv. */
function helperJSON(cmd: string, args: string[], seed?: string): any {
  const file = path.join(OUTDIR, `p2p-prod-${cmd}-${randomBytes(6).toString('hex')}.json`);
  const env = { ...process.env, E2E_L1_SOCIAL_URL: SOCIAL };
  if (seed) env.E2E_P2P_KEY = seed;
  const stdout = execFileSync(process.execPath, [HELPER, cmd, ...args, '--out', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000,
    env,
  });
  if (!fs.existsSync(file)) throw new Error(`helper ${cmd} produced no output: ${stdout}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file, { force: true });
  return data;
}

async function waitForBook(request: APIRequestContext, status: string, orderId: string, label: string) {
  for (let i = 0; i < 30; i++) {
    if ((await publicOrders(request, status).catch(() => [])).some((o) => o.orderId === orderId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timeout waiting for ${label}: ${orderId} ${status} on ${ENGINE}`);
}

const TERMS = {
  giveToken: 'USDT',
  giveAmount: '10',
  giveChain: 'L0',
  wantCurrency: 'CNY',
  wantAmount: '70',
  wantRail: 'wechat',
};

/** Fresh validity on every use — the suite may run for minutes. */
const terms = () => ({ ...TERMS, validUntil: Math.floor(Date.now() / 1000) + 900 });

test.describe('P2P production', () => {
  test.skip(!ready, 'prod P2P part not running (e2e/e2etest.sh p2p-prod)');

  test('prod chain nodes serve the P2P chain surface', async ({ request }) => {
    test.setTimeout(120_000);
    for (const [label, base] of [['L0', L0], ['L1-SOCIAL', SOCIAL], ['L1-order', ORDER]] as const) {
      const tips = await chainTips(request, base);
      const block = await chainPost(request, base, 'getBlockByHash', { hashHex: tips.prevBlockHash });
      expect(block.status, `${label} getBlockByHash`).toBe(200);
      expect(String(block.body.dataHex || ''), `${label} head block`).toMatch(/^[0-9a-f]+$/i);
    }
  });

  test('deployed engine is fail-closed and its watcher tracks L1-SOCIAL', async ({ request }) => {
    test.setTimeout(120_000);
    const caps = (await engineGet(request, '/capabilities')).body;

    expect(caps.ok).toBe(true);
    expect(Array.isArray(caps.rails)).toBe(true);
    expect(caps.rails.length).toBeGreaterThan(0);
    for (const rail of caps.rails) expect(RAILS).toContain(rail);

    // Production must prove locks on L0 and confirm order txids on L1-SOCIAL.
    expect(caps.escrow).toBe(true);
    expect(caps.escrowPubkey).toMatch(/^05[0-9a-f]{4000,12000}$/);
    expect(caps.chain).toEqual({ l0: true, l1: true, orderTxVerify: true });

    expect(caps.watch).toBeTruthy();
    expect(caps.watch.lastError).toBeNull();
    expect(caps.watch.height).toBeGreaterThan(0);
    expect(caps.watch.hash).toMatch(TXID);
    expect(Date.now() - Number(caps.watch.lastRunAt)).toBeLessThan(30 * 60 * 1000);

    const social = await chainTips(request, SOCIAL);
    expect(caps.watch.height).toBeLessThanOrEqual(social.height + 1);
    expect(caps.watch.height).toBeGreaterThan(social.height - 5000);

    // The cursor is a real block on the production social chain.
    const cursor = await chainPost(request, SOCIAL, 'getBlockByHash', { hashHex: caps.watch.hash });
    expect(cursor.status).toBe(200);
    expect(String(cursor.body.dataHex || '')).toMatch(/^[0-9a-f]+$/i);
  });

  test('public book is filtered, PII-free, and its txids are CONFIRMED on L1-SOCIAL', async ({ request }) => {
    test.setTimeout(180_000);
    const bad = await engineGet(request, '/public/orders?status=BOGUS');
    expect(bad.status).toBe(400);
    expect(String(bad.body.error || '')).toContain('ACTIVE, MATCHED or CANCELLED');

    for (const status of ['ACTIVE', 'MATCHED', 'CANCELLED']) {
      const orders = await publicOrders(request, status);
      for (const order of orders) {
        validateOrder(order, status);
        if (order.txid !== undefined) {
          expect(order.txid).toMatch(TXID);
          const proof = await chainPost(request, SOCIAL, 'getTransactionStatus', { txHash: order.txid });
          expect(proof.status, `getTransactionStatus ${order.txid}`).toBe(200);
          expect(proof.body.status, `order ${order.orderId} anchor ${order.txid}`).toBe('CONFIRMED');
        }
        const rep = await engineGet(request, `/public/reputation/${encodeURIComponent(order.sellerDid)}`);
        expect(rep.status).toBe(200);
        expect(rep.body.did).toBe(order.sellerDid);
        expect(rep.body.seller).toBeTruthy();
        expect(rep.body.buyer).toBeTruthy();
      }
    }
  });

  test('engine book agrees with an independent L1-SOCIAL replay', async ({ request }) => {
    test.setTimeout(240_000);
    const replay = await replayChain();
    expect(replay.error).toBeUndefined();
    expect(replay.conflicts).toEqual([]);
    expect(replay.scannedBlocks).toBeGreaterThan(0);

    const chainOrders = new Map(replay.orders.map((o) => [o.orderId, o]));
    const publicByStatus: Record<string, Record<string, any>[]> = {
      ACTIVE: await publicOrders(request, 'ACTIVE'),
      MATCHED: await publicOrders(request, 'MATCHED'),
      CANCELLED: await publicOrders(request, 'CANCELLED'),
    };
    const publicOrdersById = new Map(
      Object.values(publicByStatus).flat().map((o) => [o.orderId as string, o]),
    );

    // Nothing anchored on the chain may be missing/contradictory in the live
    // engine. Legacy engine-intake orders (no txid) are not a chain projection
    // and are intentionally ignored here.
    for (const order of Object.values(publicByStatus).flat()) {
      if (!order.txid) continue;
      const anchored = chainOrders.get(order.orderId);
      expect(anchored, `anchored order ${order.orderId} missing from L1-SOCIAL replay`).toBeTruthy();
      expect(anchored!.status).toBe(order.status);
      expect(anchored!.txid).toBe(order.txid);
    }

    // When the watcher is caught up, every chain order must also be visible.
    const caps = (await engineGet(request, '/capabilities')).body;
    if (Number(caps.watch?.height) >= replay.head.height! - 5) {
      for (const order of replay.orders) {
        const live = publicOrdersById.get(order.orderId);
        expect(live, `chain order ${order.orderId} missing from ${ENGINE}/public/orders`).toBeTruthy();
        expect(live!.status).toBe(order.status);
      }
    }
  });

  test('legacy engine-intake order round-trips (opt-in write)', async ({ request }) => {
    test.skip(!write, 'set E2E_PROD_P2P_WRITE=1 to write to the prod engine');
    test.setTimeout(180_000);
    const seed = await freshSeed();
    const identity = await signBody(seed, {});
    // Legacy intake (no txid) lets the engine mint the orderId; the anchored
    // path is the one where the client supplies it.
    let orderId = '';
    let cancelled = false;

    try {
      const signed = await signBody(seed, {
        ...terms(),
        sellerDid: identity.did,
        requestMethod: 'POST',
        requestPath: '/orders',
      });
      const created = await request.post(`${ENGINE}/orders`, { data: signed.body, timeout: 60_000 });
      const createdText = await created.text();
      expect(created.status(), createdText).toBe(201);
      orderId = JSON.parse(createdText).orderId;
      expect(orderId).toMatch(ORDER_ID);

      await waitForBook(request, 'ACTIVE', orderId, 'legacy intake');
      const live = (await publicOrders(request, 'ACTIVE')).find((o) => o.orderId === orderId)!;
      validateOrder(live, 'ACTIVE');
      expect(live.txid).toBeUndefined();

      const repost = await signBody(seed, {
        ...terms(),
        sellerDid: identity.did,
        orderId,
        requestMethod: 'POST',
        requestPath: '/orders',
      });
      const again = await request.post(`${ENGINE}/orders`, { data: repost.body, timeout: 60_000 });
      expect(again.status()).toBe(200);
      expect((await again.json()).orderId).toBe(orderId);

      const cancel = await signBody(seed, {
        sellerDid: identity.did,
        orderId,
        requestMethod: 'POST',
        requestPath: `/orders/${orderId}/cancel`,
      });
      const cancelledRes = await request.post(`${ENGINE}/orders/${orderId}/cancel`, {
        data: cancel.body,
        timeout: 60_000,
      });
      expect(cancelledRes.status()).toBe(200);
      cancelled = true;
      await waitForBook(request, 'CANCELLED', orderId, 'legacy cancel');
      expect((await publicOrders(request, 'ACTIVE')).some((o) => o.orderId === orderId)).toBe(false);
    } finally {
      if (!cancelled) {
        const cleanup = await signBody(seed, {
          sellerDid: identity.did,
          orderId,
          requestMethod: 'POST',
          requestPath: `/orders/${orderId}/cancel`,
        }).catch(() => null);
        if (cleanup) {
          await request
            .post(`${ENGINE}/orders/${orderId}/cancel`, { data: cleanup.body, timeout: 30_000 })
            .catch(() => undefined);
        }
      }
    }
  });

  test('prod engine fails closed on unconfirmed anchors (opt-in write)', async ({ request }) => {
    test.skip(!write, 'set E2E_PROD_P2P_WRITE=1 to write to the prod engine');
    test.setTimeout(180_000);
    const seed = await freshSeed();
    const identity = await signBody(seed, {});
    const orderId = `ord-${randomBytes(8).toString('hex')}`;

    const bogus = await signBody(seed, {
      ...terms(),
      sellerDid: identity.did,
      orderId,
      txid: '0'.repeat(64),
      requestMethod: 'POST',
      requestPath: '/orders',
    });
    const rejected = await request.post(`${ENGINE}/orders`, { data: bogus.body, timeout: 60_000 });
    const rejectedText = await rejected.text();
    expect(rejected.status(), rejectedText).toBe(409);
    expect(rejectedText).toContain('txid not confirmed');
    expect((await publicOrders(request, 'ACTIVE')).some((o) => o.orderId === orderId)).toBe(false);

    const unknownId = `ord-${randomBytes(8).toString('hex')}`;
    const cancel = await signBody(seed, {
      sellerDid: identity.did,
      orderId: unknownId,
      requestMethod: 'POST',
      requestPath: `/orders/${unknownId}/cancel`,
    });
    const missing = await request.post(`${ENGINE}/orders/${unknownId}/cancel`, {
      data: cancel.body,
      timeout: 30_000,
    });
    expect(missing.status()).toBe(404);

    const match = await signBody(seed, {
      buyerDid: identity.did,
      receiveAddress: '1FvyAqqELFiQyaEWdhFbWF8MZapKPZS8J7',
      requestMethod: 'POST',
      requestPath: `/orders/${unknownId}/match`,
    });
    const noMatch = await request.post(`${ENGINE}/orders/${unknownId}/match`, {
      data: match.body,
      timeout: 30_000,
    });
    expect(noMatch.status()).toBe(404);
  });

  test('seller-anchored order is confirmed on prod L1-SOCIAL (opt-in funded seed)', async ({ request }) => {
    test.skip(!sellerSeed, 'set E2E_PROD_P2P_SEED to a seller key funded with BIG on L1-SOCIAL');
    test.setTimeout(600_000);
    const orderId = `ord-${randomBytes(8).toString('hex')}`;
    let created = false;

    try {
      const open = helperJSON('anchor-order', [
        '--network', 'mainnet',
        '--orderId', orderId,
        '--terms', JSON.stringify(terms()),
      ], sellerSeed);
      expect(open.txid).toMatch(TXID);

      const signed = await signBody(sellerSeed, {
        ...open.fields,
        requestMethod: 'POST',
        requestPath: '/orders',
      });
      const intake = await request.post(`${ENGINE}/orders`, { data: signed.body, timeout: 120_000 });
      // 201 = intake indexed it; 200 = the projector already did.
      expect([200, 201]).toContain(intake.status());
      expect((await intake.json()).orderId).toBe(orderId);
      created = true;

      await waitForBook(request, 'ACTIVE', orderId, 'anchored intake');
      const live = (await publicOrders(request, 'ACTIVE')).find((o) => o.orderId === orderId)!;
      expect(live.txid).toBe(open.txid);
      const proof = await chainPost(request, SOCIAL, 'getTransactionStatus', { txHash: open.txid });
      expect(proof.body.status).toBe('CONFIRMED');

      const cancel = helperJSON('anchor-order', [
        '--network', 'mainnet',
        '--orderId', orderId,
        '--status', 'CANCELLED',
      ], sellerSeed);
      expect(cancel.txid).toMatch(TXID);
      const cancelBody = await signBody(sellerSeed, {
        ...cancel.fields,
        requestMethod: 'POST',
        requestPath: `/orders/${orderId}/cancel`,
      });
      const cancelled = await request.post(`${ENGINE}/orders/${orderId}/cancel`, {
        data: cancelBody.body,
        timeout: 120_000,
      });
      expect(cancelled.status()).toBe(200);
      await waitForBook(request, 'CANCELLED', orderId, 'anchored cancel');
      created = false;
    } finally {
      if (created) {
        // Leave the chain consistent: anchor + submit the cancel even on a
        // failed assertion above. The seed is only in env, never argv.
        try {
          const cancel = helperJSON('anchor-order', [
            '--network', 'mainnet',
            '--orderId', orderId,
            '--status', 'CANCELLED',
          ], sellerSeed);
          const body = await signBody(sellerSeed, {
            ...cancel.fields,
            requestMethod: 'POST',
            requestPath: `/orders/${orderId}/cancel`,
          });
          await request.post(`${ENGINE}/orders/${orderId}/cancel`, { data: body.body, timeout: 120_000 });
        } catch {
          // best effort — the order has a short validUntil and is unspendable
        }
      }
    }
  });

  test('deployed wallet mounts the P2P book against the live engine', async ({ page }) => {
    test.skip(!WALLET, 'set E2E_PROD_WALLET_URL to smoke the deployed web build');
    test.setTimeout(120_000);

    await page.goto(WALLET, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(3000);

    const capabilities = page.waitForResponse(
      (res) => res.url().includes('/p2p/capabilities') && res.request().method() === 'GET',
      { timeout: 30_000 },
    );
    const book = page.waitForResponse(
      (res) => res.url().includes('/p2p/public/orders') && res.request().method() === 'GET',
      { timeout: 30_000 },
    );

    await clickTab(page, 'P2P');
    expect((await capabilities).status()).toBe(200);
    expect((await book).status()).toBe(200);

    await expect(page.getByTestId('p2p-tab-open')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('p2p-not-configured')).toHaveCount(0);
    await expect(page.getByTestId('p2p-book-count')).toContainText('ads');
  });
});
