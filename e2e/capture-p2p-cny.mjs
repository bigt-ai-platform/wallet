#!/usr/bin/env node
/**
 * Capture the P2P CNY (WeChat Pay / 支付宝) settlement flow and save numbered
 * screenshots to docs/p2p-demo/assets/screenshots/p2p-cny-NN-*-en.png.
 *
 * The guide built from them is docs/p2p-demo/p2p-cny.md → assets/p2p-cny.pdf
 * (the same "markdown + screenshots → PDF" pattern as the dai idif guide).
 *
 * Self-contained: starts the p2p-engine (mem store, insecure PayPal, no chain
 * check — a CNY swap needs no L0/L1) with a generated engine DID, serves
 * e2e/web-build, and drives two fresh wallets through
 *   profile → list (rail=wechat) → match → lock → instructions → proof →
 *   confirm → release → complete.
 * The release/complete legs are signed with the engine key, exactly what the
 * production engine signer does after the seller confirms.
 *
 * Usage: node capture-p2p-cny.mjs   (from e2e/, after `expo-app` web:build)
 *        KEEP=1 node capture-p2p-cny.mjs   # leave the servers running
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
// The product signs with PQ (ML-DSA-87) did:key — EC/Ed25519 dids only remain
// for compatibility (docs/p2p.md). Same helpers the wallet client uses
// (expo-app/sources/lib/p2pIdentity.ts).
import { PQKey, Sha256Hash, Utils } from 'bigtangle-ts';
import { didFromPQKey } from 'did/pq';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const APP = (process.env.APP_URL || 'http://localhost:18081').replace(/\/+$/, '') + '/';
const ENGINE = process.env.E2E_P2P_ENGINE_URL || 'http://localhost:18089';
const WEB_PORT = Number(new URL(APP).port || 8081);
const ENGINE_PORT = Number(new URL(ENGINE).port || 8089);
const SHOTS = resolve(ROOT, 'docs/p2p-demo/assets/screenshots');
const PWD = 'CnyDemoPass123!';
const TIMEOUT = 30000;
mkdirSync(SHOTS, { recursive: true });

const engineKey = PQKey.createNewKey();
const engineDid = didFromPQKey(engineKey);
/** Prefixed ML-DSA public key → lets the engine derive the 2-of-3 escrow address. */
const enginePubHex = Utils.HEX.encode(engineKey.getPrefixedPublicKeyBytes());
const children = [];
const timeline = [];
const at = (step) => {
  const t = new Date().toISOString().slice(11, 19);
  timeline.push(`${t}  ${step}`);
  console.log(`  · ${t}  ${step}`);
};

/** Same shape the wallet sends: PQ signature over sha256(canonical JSON). */
function canonSign(fields) {
  const payload = { ...fields, did: engineDid, nonce: randomBytes(8).toString('hex'), timestamp: Date.now() };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonical));
  const signature = Utils.HEX.encode(engineKey.sign(Sha256Hash.wrap(digest)).serialize());
  return { ...payload, signature };
}

async function api(pathname, body) {
  const res = await fetch(ENGINE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${data.error || ''}`);
  return data;
}

function listen(port) {
  try {
    execFileSync('bash', ['-lc', `timeout 2 bash -c "</dev/tcp/127.0.0.1/${port}"`]);
    return true;
  } catch {
    return false;
  }
}

async function waitHealth(url, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`not reachable: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** A leftover engine from an earlier e2e run would not know our engine DID. */
function freePort(port) {
  if (!listen(port)) return;
  try {
    execFileSync('bash', ['-lc', `pkill -f "server.bundle.mjs" || true`]);
  } catch {
    /* ignore */
  }
  const t0 = Date.now();
  while (listen(port) && Date.now() - t0 < 8000) {
    execSyncSleep(200);
  }
}
function execSyncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startServers() {
  freePort(ENGINE_PORT);
  const engine = spawn('node', [resolve(ROOT, 'services/p2p-engine/dist/server.bundle.mjs')], {
    env: {
      ...process.env,
      PORT: String(ENGINE_PORT),
      HOST: '127.0.0.1',
      SETTLEMENT_STORE: 'mem',
      SETTLEMENT_PAYPAL_INSECURE: '1',
      SETTLEMENT_ADMIN_TOKEN: 'adm',
      SETTLEMENT_ENGINE_DID: engineDid,
      SETTLEMENT_ENGINE_PUBKEY: enginePubHex,
      SETTLEMENT_CNY_RAILS: 'wechat,alipay,bank',
      CORS_ORIGIN: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  engine.stdout.on('data', (d) => process.env.CAPTURE_VERBOSE && process.stdout.write(`[engine] ${d}`));
  engine.stderr.on('data', (d) => process.stdout.write(`[engine] ${d}`));
  children.push(engine);

  if (!listen(WEB_PORT)) {
    const web = spawn(resolve(ROOT, 'node_modules/.bin/http-server'), [resolve(ROOT, 'e2e/web-build'), '-p', String(WEB_PORT), '--silent'], {
      stdio: 'ignore',
      detached: false,
    });
    children.push(web);
  }
}

function cleanup() {
  if (process.env.KEEP === '1') return;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ── wallet helpers (same flow the p2p-ui Playwright spec uses) ──────────────

async function openNav(page, label) {
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  } else {
    const back = page.getByRole('button', { name: 'Back' });
    if (await back.isVisible().catch(() => false)) {
      await back.click();
      await page.waitForTimeout(800);
    }
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.waitForTimeout(400);
    }
  }
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

async function createWallet(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      delete globalThis.showSaveFilePicker;
    } catch {
      /* ignore */
    }
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[browser error] ${m.text()}`);
  });
  page.on('response', async (r) => {
    if (r.url().startsWith(ENGINE)) {
      console.log(`[engine ${r.status()}] ${new Date().toISOString().slice(11, 19)} ${r.request().method()} ${new URL(r.url()).pathname} [wallet:${name}]`);
    } else if (r.status() >= 400 && !r.url().includes('/l0/') && !r.url().includes('/l1/')) {
      console.log(`[http ${r.status()}] ${r.url()} ${await r.text().catch(() => '')}`);
    }
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await openNav(page, 'Keys');
  await page.getByText('Create New Wallet').click();
  await page.getByText('New Wallet Created!').waitFor({ timeout: TIMEOUT });
  await page.getByText('Save with Password').click();
  await page.getByText('Set Wallet Password').waitFor({ timeout: TIMEOUT });
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PWD);
  await page.getByPlaceholder('Confirm password').fill(PWD);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/p2p-cny-${name}-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
  return { context, page };
}

const el = (page, id) => page.locator(`[data-testid="${id}"]`);

async function waitForStatus(page, expected, id = 'p2p-swap-0-status') {
  const t0 = Date.now();
  for (;;) {
    const txt = await el(page, id).first().textContent().catch(() => null);
    if (txt === expected) return;
    if (Date.now() - t0 > TIMEOUT) {
      const notice = await el(page, 'p2p-notice').first().textContent().catch(() => null);
      throw new Error(`timeout: want ${expected}, got ${txt} | notice: ${notice}`);
    }
    await page.waitForTimeout(300);
  }
}

async function refresh(page) {
  await el(page, 'p2p-refresh').click();
  await page.waitForTimeout(1200);
}

async function shot(page, name) {
  const path = resolve(SHOTS, name);
  await page.screenshot({ path, fullPage: true });
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log(`engine DID: ${engineDid.slice(0, 46)}… (ML-DSA-87, ${engineDid.length} chars)`);
  startServers();
  await waitHealth(`${ENGINE}/healthz`);
  await waitHealth(APP, 60000);
  at('engine + wallet web app up');

  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1. seller saves the WeChat collection profile ──────────────────────
    const seller = await createWallet(browser, 'seller');
    const buyer = await createWallet(browser, 'buyer');
    at('both wallets created');

    const s = seller.page;
    await openNav(s, 'P2P');
    await el(s, 'p2p-tab-mine').click();
    await s.waitForTimeout(800);
    await el(s, 'p2p-profile-method-wechat').click();
    await el(s, 'p2p-profile-name').fill('Zhang San');
    await el(s, 'p2p-profile-account').fill('wxid_pay8888');
    await el(s, 'p2p-profile-save').click();
    await s.waitForTimeout(1500);
    await shot(s, 'p2p-cny-01-profile-en.png');
    at('seller payment profile saved (wechat)');

    // ── 2. seller lists 10 USDT for 715 CNY via wechat ─────────────────────
    await el(s, 'p2p-tab-open').click();
    await s.waitForTimeout(600);
    await el(s, 'p2p-give-token').fill('USDT');
    await el(s, 'p2p-give-amount').fill('10');
    await el(s, 'p2p-want-amount').fill('715');
    await el(s, 'p2p-rail-wechat').click();
    await s.waitForTimeout(400);
    await el(s, 'p2p-want-currency').fill('CNY');
    await shot(s, 'p2p-cny-02-order-en.png');
    await el(s, 'p2p-create').click();
    await s.waitForTimeout(2000);
    at('sell order listed (wantRail=wechat, 715 CNY)');

    // ── 3. buyer matches — no PayPal fields on a CNY order ─────────────────
    const b = buyer.page;
    await openNav(b, 'P2P');
    await el(b, 'p2p-order-0').waitFor({ timeout: TIMEOUT });
    await el(b, 'p2p-buy-0').click();
    await el(b, 'p2p-buy-recv').fill('BCnyDemoBuyerReceiveAddress');
    await b.waitForTimeout(400);
    await shot(b, 'p2p-cny-03-match-en.png');
    await el(b, 'p2p-buy-confirm').click();
    await waitForStatus(b, 'MATCHED');
    await shot(b, 'p2p-cny-04-matched-en.png');
    at('buyer matched the order (no paypalAccount / buyerEmail)');

    // ── 4. seller locks the 2-of-3 escrow ──────────────────────────────────
    // The engine allows 10 signed calls per DID per 60s (sign.ts RATE_LIMIT);
    // the seller is at its ceiling after profile + list + match, so let the
    // earlier nonces expire before the lock/confirm leg.
    await new Promise((r) => setTimeout(r, 70000));
    at('paced 70s past the engine rate-limit window');
    await refresh(s);
    await waitForStatus(s, 'MATCHED');
    await el(s, 'p2p-swap-0-txhash').fill('ab'.repeat(32));
    await shot(s, 'p2p-cny-05-escrow-lock-en.png');
    await el(s, 'p2p-swap-0-lock').click();
    await waitForStatus(s, 'ESCROW_LOCKED');
    await shot(s, 'p2p-cny-06-escrow-locked-en.png');
    at('escrow lock recorded (ESCROW_LOCKED)');

    // ── 5. buyer pulls the signed payment instructions ─────────────────────
    await refresh(b);
    await waitForStatus(b, 'ESCROW_LOCKED');
    await shot(b, 'p2p-cny-07-buy-locked-en.png');
    await el(b, 'p2p-swap-0-instructions').click();
    await el(b, 'p2p-swap-0-instructions-panel').waitFor({ timeout: TIMEOUT });
    await b.waitForTimeout(600);
    await shot(b, 'p2p-cny-08-instructions-en.png');
    at('buyer pulled payment instructions (户名 / account / 715 CNY / remark)');
    const panelText = await el(b, 'p2p-swap-0-instructions-panel').textContent();
    const remark = (panelText.match(/Remark:\s*([0-9a-f]+)/) ?? [])[1] ?? '';

    // ── 6. buyer pays WeChat and claims with the 流水号 ─────────────────────
    const txId = '4203' + randomBytes(8).toString('hex').slice(0, 12).toUpperCase();
    await el(b, 'p2p-swap-0-txid').fill(txId);
    await b.waitForTimeout(400);
    await shot(b, 'p2p-cny-09-payment-pending-en.png');
    await el(b, 'p2p-swap-0-proof').click();
    await waitForStatus(b, 'PAYMENT_CLAIMED');
    await shot(b, 'p2p-cny-10-payment-claimed-en.png');
    at(`buyer claimed payment (流水号 ${txId})`);

    // ── 7. seller verifies in their own WeChat app, then confirms ──────────
    await refresh(s);
    await waitForStatus(s, 'PAYMENT_CLAIMED');
    await shot(s, 'p2p-cny-11-seller-confirm-en.png');
    await el(s, 'p2p-swap-0-confirm').click();
    await waitForStatus(s, 'PAYMENT_VERIFIED');
    await shot(s, 'p2p-cny-12-payment-verified-en.png');
    at('seller confirmed receipt (PAYMENT_VERIFIED)');

    // ── 8. engine signs release + complete (what the production signer does)
    const swapId = (await el(b, 'p2p-swap-0').textContent()).match(/swap-[0-9a-f]{16}/)[0];
    const release = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'release', txHash: 'cd'.repeat(32) }));
    if (release.status !== 'ESCROW_RELEASED') throw new Error(`release → ${release.status}`);
    at('engine signed the release (ESCROW_RELEASED)');
    await refresh(b);
    await waitForStatus(b, 'ESCROW_RELEASED');
    await shot(b, 'p2p-cny-13-escrow-released-en.png');

    const complete = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'complete' }));
    if (complete.status !== 'COMPLETED') throw new Error(`complete → ${complete.status}`);
    at('swap completed (COMPLETED) — seller already holds the CNY');

    await refresh(b);
    await waitForStatus(b, 'COMPLETED');
    await shot(b, 'p2p-cny-14-completed-en.png');

    const report = { engineDid, swapId, txId, remark, timeline, capturedAt: new Date().toISOString() };
    writeFileSync(resolve(HERE, 'demo-output/p2p-cny-capture.json'), JSON.stringify(report, null, 2));
    console.log('\nTimeline:');
    for (const line of timeline) console.log(`  ${line}`);
    console.log(`\nwrote e2e/demo-output/p2p-cny-capture.json (swapId=${swapId})`);
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((e) => {
    console.error('FAILED:', e);
    cleanup();
    process.exit(1);
  });
