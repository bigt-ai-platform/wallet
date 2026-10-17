import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Chain order book on L1-SOCIAL (docs/p2p.md §11/§14): the seller anchors its
 * own `social.p2p-order` record, the intake engine only indexes a CONFIRMED
 * txid, and a second cold engine rebuilds the same book from the chain alone.
 *
 * Runs via `e2e/e2etest.sh p2p-orders` (L1-SOCIAL + two chain engines);
 * skipped otherwise so `all`/`remaining` greps stay green without that infra.
 */
const ENGINE = (process.env.E2E_P2P_ORDERS_URL || '').replace(/\/+$/, '');
const REPLAY = (process.env.E2E_P2P_REPLAY_URL || '').replace(/\/+$/, '');
const SOCIAL = process.env.E2E_L1_SOCIAL_URL || '';
const ENGINE_KEY = process.env.SETTLEMENT_ENGINE_KEY || '';
const READY = Boolean(ENGINE && REPLAY && SOCIAL && ENGINE_KEY);

const HELPER = path.join(process.cwd(), 'p2p-order-chain.mjs');
const OUTDIR = path.join(process.cwd(), 'test-results');
fs.mkdirSync(OUTDIR, { recursive: true });

function helperJSON(cmd: string, args: string[]): any {
  const file = path.join(OUTDIR, `p2p-order-${cmd}-${randomBytes(6).toString('hex')}.json`);
  const stdout = execFileSync(process.execPath, [HELPER, cmd, ...args, '--out', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The `fund` command legitimately polls up to ~240s for the genesis
    // spend candidates on a cold chain (see the helper), then pays + waits for
    // CONFIRMED — 240s was exactly the helper's own poll budget, so it always
    // tripped. Keep this well above the helper's internal waits.
    timeout: 600_000,
    env: process.env,
  });
  if (!fs.existsSync(file)) throw new Error(`helper ${cmd} produced no output: ${stdout}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(file, { force: true });
  return data;
}

test.describe('P2P Orders (chain)', () => {
  test.skip(!READY, 'p2p-orders part not running (e2e/e2etest.sh p2p-orders)');

  test('seller-anchored book, cancel/match conflicts, cold replay', async ({ request }) => {
    test.setTimeout(900_000);

    const post = async (base: string, route: string, data: unknown) => {
      const res = await request.post(`${base}${route}`, { data, timeout: 60_000 });
      return { status: res.status(), body: await res.json().catch(() => ({}) as any) };
    };
    const signBody = (key: string, fields: Record<string, unknown>) =>
      helperJSON('sign', ['--key', key, '--fields', JSON.stringify(fields)]).body;
    const orderIds = async (base: string, status: string): Promise<string[]> => {
      const res = await request.get(`${base}/public/orders?status=${status}`);
      const data = await res.json();
      return (data.orders ?? []).map((o: { orderId: string }) => o.orderId);
    };
    const waitForOrder = async (base: string, status: string, orderId: string, label: string) => {
      for (let i = 0; i < 90; i++) {
        if ((await orderIds(base, status).catch(() => [] as string[])).includes(orderId)) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`timeout waiting for ${label}: ${orderId} ${status} on ${base}`);
    };
    const waitForWatch = async (base: string) => {
      for (let i = 0; i < 30; i++) {
        const res = await request.get(`${base}/capabilities`);
        const caps = await res.json().catch(() => ({}));
        if (caps.watch && caps.watch.lastRunAt && !caps.watch.lastError) return caps;
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`watch never settled cleanly on ${base}`);
    };

    const TERMS = {
      giveToken: 'USDT',
      giveAmount: '100',
      giveChain: 'L0',
      wantCurrency: 'CNY',
      wantAmount: '720',
      wantRail: 'wechat',
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    };
    const orderId1 = `ord-${randomBytes(8).toString('hex')}`;
    const orderId2 = `ord-${randomBytes(8).toString('hex')}`;
    const orderId3 = `ord-${randomBytes(8).toString('hex')}`;
    const orderId4 = `ord-${randomBytes(8).toString('hex')}`;
    const ourIds = [orderId1, orderId2, orderId3, orderId4];

    // Fund the seller AND the engine's anchor key in one genesis spend; the
    // helper returns only after both are CONFIRMED and spendable.
    const seller = helperJSON('keygen', []);
    const buyer = helperJSON('keygen', []);
    helperJSON('fund', ['--keys', `${seller.key},${ENGINE_KEY}`]);

    const caps = await (await request.get(`${ENGINE}/capabilities`)).json();
    expect(caps.chain.l1).toBe(true);
    expect(caps.chain.orderTxVerify).toBe(true);
    expect(caps.watch).not.toBeNull();

    // --- order 1: anchor OPEN → intake (txid-gated) + idempotent re-post ---
    const open1 = helperJSON('anchor-order', [
      '--key', seller.key, '--orderId', orderId1, '--terms', JSON.stringify(TERMS),
    ]);
    expect(open1.txid).toMatch(/^[0-9a-f]{64}$/i);
    const created = await post(ENGINE, '/orders', signBody(seller.key, open1.fields));
    // 201 = intake created it; 200 = the chain projector already indexed the
    // anchored record (idempotent re-register). Both leave the same ACTIVE order.
    expect([200, 201]).toContain(created.status);
    expect(created.body).toMatchObject({ orderId: orderId1, status: 'ACTIVE', txid: open1.txid });

    const repost = await post(ENGINE, '/orders', signBody(seller.key, open1.fields));
    expect(repost.status).toBe(200);
    expect(repost.body).toMatchObject({ orderId: orderId1, status: 'ACTIVE' });

    // An unconfirmed/unknown txid must never be indexed (fail-closed gate).
    const bogus = await post(ENGINE, '/orders', signBody(seller.key, {
      sellerDid: seller.did, orderId: orderId3, txid: '0'.repeat(64), ...TERMS,
    }));
    expect(bogus.status).toBe(409);
    expect(bogus.body.error).toMatch(/txid not confirmed/);
    expect(await orderIds(ENGINE, 'ACTIVE')).not.toContain(orderId3);

    await waitForOrder(REPLAY, 'ACTIVE', orderId1, 'cold replay indexes the OPEN record');

    // --- order 2: anchor + intake, then buyer match (engine anchors swap) ---
    const open2 = helperJSON('anchor-order', [
      '--key', seller.key, '--orderId', orderId2, '--terms', JSON.stringify(TERMS),
    ]);
    const created2 = await post(ENGINE, '/orders', signBody(seller.key, open2.fields));
    expect([200, 201]).toContain(created2.status);

    const matched = await post(ENGINE, `/orders/${orderId2}/match`, signBody(buyer.key, {
      buyerDid: buyer.did, receiveAddress: buyer.address,
    }));
    expect(matched.status).toBe(201);
    expect(matched.body.swapId).toMatch(/^swap-[0-9a-f]{16}$/);
    expect(matched.body.escrowAddress).toBeTruthy();

    await waitForOrder(ENGINE, 'MATCHED', orderId2, 'intake marks the order matched');
    await waitForOrder(REPLAY, 'MATCHED', orderId2, 'replay projects the anchored swap event');

    // --- order 1: seller cancel (anchored) + idempotent re-post ---
    const cancel1 = helperJSON('anchor-order', ['--key', seller.key, '--orderId', orderId1, '--status', 'CANCELLED']);
    expect(cancel1.txid).toMatch(/^[0-9a-f]{64}$/i);
    const cancelled = await post(ENGINE, `/orders/${orderId1}/cancel`, signBody(seller.key, cancel1.fields));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ orderId: orderId1, status: 'CANCELLED' });

    const recancel = await post(ENGINE, `/orders/${orderId1}/cancel`, signBody(seller.key, cancel1.fields));
    expect(recancel.status).toBe(200);
    expect(recancel.body.status).toBe('CANCELLED');

    await waitForOrder(ENGINE, 'CANCELLED', orderId1, 'intake cancels the order');
    await waitForOrder(REPLAY, 'CANCELLED', orderId1, 'replay applies the CANCELLED record');

    // --- transition conflicts: chain/API order decides, losers get 409 ---
    const cancelMatched = await post(ENGINE, `/orders/${orderId2}/cancel`, signBody(seller.key, {
      sellerDid: seller.did, orderId: orderId2,
    }));
    expect(cancelMatched.status).toBe(409);
    expect(cancelMatched.body.error).toMatch(/MATCHED/);

    const matchCancelled = await post(ENGINE, `/orders/${orderId1}/match`, signBody(buyer.key, {
      buyerDid: buyer.did, receiveAddress: buyer.address,
    }));
    expect(matchCancelled.status).toBe(409);
    expect(matchCancelled.body.error).toMatch(/CANCELLED/);

    const unknown = await post(ENGINE, `/orders/${orderId4}/cancel`, signBody(seller.key, {
      sellerDid: seller.did, orderId: orderId4,
    }));
    expect(unknown.status).toBe(404);

    const wrongSeller = await post(ENGINE, `/orders/${orderId1}/cancel`, signBody(buyer.key, {
      sellerDid: buyer.did, orderId: orderId1,
    }));
    expect(wrongSeller.status).toBe(403);
    expect(wrongSeller.body.error).toMatch(/not the seller/);

    // --- watchers: both engines ran clean, and both books agree on our ids ---
    const capsA = await waitForWatch(ENGINE);
    const capsB = await waitForWatch(REPLAY);
    expect(capsB.chain.orderTxVerify).toBe(true);
    for (const status of ['ACTIVE', 'MATCHED', 'CANCELLED']) {
      const a = (await orderIds(ENGINE, status)).filter((id) => ourIds.includes(id)).sort();
      const b = (await orderIds(REPLAY, status)).filter((id) => ourIds.includes(id)).sort();
      expect(b, `status ${status}: intake vs cold replay`).toEqual(a);
    }
    expect(await orderIds(ENGINE, 'ACTIVE')).not.toContain(orderId1);
    expect(await orderIds(REPLAY, 'ACTIVE')).not.toContain(orderId1);
    expect(capsA.watch.height).toBeGreaterThanOrEqual(0);
  });
});
