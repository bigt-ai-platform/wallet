#!/usr/bin/env node
/**
 * Capture the P2P demo — **BIG → CNY, buy and sell over WeChat** — with the
 * FUNDS-FREE harness: a local `p2p-engine` (memory store, no chain client) and
 * the wallet web build. Nothing leaves a wallet; the escrow lock/release legs
 * use synthetic transaction hashes. This is the demo/PDF pipeline (the
 * production-escrow capture is operator-only, see capture-p2p-prod.mjs).
 *
 * Screenshots are written per *wallet UI language*:
 *   docs/p2p-demo/assets/screenshots/p2p-cny-wechat-NN-*-<lang>.png
 * so a guide whose language is `zh` shows a Chinese UI (docs-pdf.mts picks
 * `<file>-<lang>.png` and falls back to `-en.png`).
 *
 * Usage (from e2e/, after `expo-app` web:build):
 *   node capture-p2p-cny.mjs                 # English (14 shots)
 *   LANGS=zh,de node capture-p2p-cny.mjs     # one full flow per language
 *   LANGS=ko KEEP=1 node capture-p2p-cny.mjs # leave the servers running
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
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
const TIMEOUT = 45_000;
/** Wallet UI languages to shoot (`LANGS=zh,de`); the demo is WeChat-only. */
const LANGS = (process.env.LANGS || 'en').split(',').map((l) => l.trim()).filter(Boolean);
const RAIL = 'wechat';
mkdirSync(SHOTS, { recursive: true });

const engineKey = PQKey.createNewKey();
const engineSeed = engineKey.getPrivateKeySeedAsHex();
const engineDid = didFromPQKey(engineKey);
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
  const payload = { ...fields, requestMethod: 'POST', requestPath: `/swaps/${fields.swapId}/transitions`, did: engineDid, nonce: randomBytes(8).toString('hex'), timestamp: Date.now() };
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

function execSyncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function freePort(port) {
  if (!listen(port)) return;
  try {
    execFileSync('bash', ['-lc', `pkill -f "server.bundle.mjs" || true`]);
  } catch {
    /* ignore */
  }
  const t0 = Date.now();
  while (listen(port) && Date.now() - t0 < 8000) execSyncSleep(200);
}

function startServers() {
  freePort(ENGINE_PORT);
  const engine = spawn('node', [resolve(ROOT, 'services/p2p-engine/dist/server.bundle.mjs')], {
    env: {
      ...process.env,
      PORT: String(ENGINE_PORT),
      HOST: '127.0.0.1',
      SETTLEMENT_STORE: 'mem',
      SETTLEMENT_ADMIN_TOKEN: 'adm',
      SETTLEMENT_ENGINE_DID: engineDid,
      // one seed backs the DID (anchor/records), the escrow participant and the
      // pin the wallet puts on the order — the ring must hold it or the match
      // fails closed with "pinned to an engine this deployment does not hold"
      SETTLEMENT_ENGINE_KEY: engineSeed,
      SETTLEMENT_ESCROW_KEY: engineSeed,
      SETTLEMENT_ENGINE_PUBKEY: enginePubHex,
      SETTLEMENT_CNY_RAILS: 'wechat',
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

// ── browser helpers ─────────────────────────────────────────────────────────

const el = (page, id) => page.locator(`[data-testid="${id}"]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openNav(page, label) {
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

/** Approve the wallet-password confirmation sheet when it appears. */
async function approve(page) {
  const sheet = page.locator('[data-testid="confirm-transaction"]');
  const ok = await sheet.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  if (!ok) return false;
  await page.locator('[data-testid="confirm-password"]').fill(PWD);
  await page.locator('[data-testid="confirm-ok"]').click();
  await page.waitForTimeout(800);
  return true;
}

async function createWallet(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try { delete globalThis.showSaveFilePicker; } catch { /* ignore */ }
    try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch { /* ignore */ }
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser:${name}]`, m.text()); });
  page.on('response', async (r) => {
    if (r.url().startsWith(ENGINE) && r.status() >= 400) {
      const body = await r.text().catch(() => '');
      console.log(`[engine ${r.status()}] ${r.request().method()} ${new URL(r.url()).pathname} ${body.slice(0, 300)}`);
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
  // The Keys screen shows the full address (the home screen truncates it).
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const address = (text.match(/\b[1-9A-HJ-NP-Za-km-z]{26,40}\b/) ?? [])[0] ?? '';
  return { context, page, address };
}

/** Switch the wallet UI language in place (the i18n instance is exposed on web). */
async function setLanguage(page, lang) {
  if (lang === 'en') return;
  const ok = await page.evaluate((l) => {
    const i = globalThis.__bigtangleI18n;
    if (!i?.changeLanguage) return false;
    i.changeLanguage(l);
    return true;
  }, lang).catch(() => false);
  if (!ok) throw new Error(`could not switch the UI language to ${lang}`);
  await page.waitForTimeout(1200);
}

async function gotoP2P(page) {
  await openNav(page, 'P2P');
  for (let i = 0; i < 20; i++) {
    if (await el(page, 'p2p-tab-mine').count()) return;
    const pwd = el(page, 'wallet-password-input').first();
    if (await pwd.isVisible().catch(() => false)) {
      await pwd.fill(PWD);
      await el(page, 'unlock-wallet-button').first().click();
      await page.waitForTimeout(2500);
      continue;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('P2P screen did not mount');
}

async function shot(page, name, selector) {
  if (selector) {
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return;
      node.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -60);
    }, selector).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: resolve(SHOTS, name) });
  console.log(`  ✓ ${name}`);
}

async function refresh(page) {
  await el(page, 'p2p-refresh').click().catch(() => {});
  await page.waitForTimeout(1500);
}

async function statusOf(page, id = 'p2p-swap-0-status') {
  return (await el(page, id).first().textContent().catch(() => null)) ?? '';
}

async function waitStatus(page, expected, ms = TIMEOUT, id = 'p2p-swap-0-status') {
  const list = Array.isArray(expected) ? expected : [expected];
  const t0 = Date.now();
  for (;;) {
    const txt = await statusOf(page, id);
    if (list.includes(txt)) return txt;
    if (Date.now() - t0 > ms) {
      const notice = await el(page, 'p2p-notice').first().textContent().catch(() => null);
      throw new Error(`timeout: want ${list.join('|')}, got "${txt}" | notice: ${notice}`);
    }
    await page.waitForTimeout(400);
  }
}

/** Click a control until the swap reaches `expected` (rate-limit retries). */
async function actUntil(page, testid, expected, { tries = 6, wait = 20_000, ms = TIMEOUT } = {}) {
  const list = Array.isArray(expected) ? expected : [expected];
  let last;
  for (let i = 0; i < tries; i++) {
    await el(page, testid).click().catch(() => {});
    await approve(page);
    try {
      return await waitStatus(page, list, ms);
    } catch (e) {
      last = e;
      console.log(`  ${testid} not through yet — retry ${i + 1}/${tries}`);
      await sleep(wait);
      await refresh(page).catch(() => {});
    }
  }
  throw last;
}

/** Cancel ads/swaps an interrupted run left open for this DID pair. */
async function cleanupState(page) {
  await el(page, 'p2p-tab-open').click().catch(() => {});
  await page.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) {
    const toggle = el(page, `p2p-order-${i}-toggle`);
    if (!(await toggle.count())) break;
    await toggle.click();
    await page.waitForTimeout(400);
    const cancel = el(page, `p2p-cancel-order-${i}`);
    if (await cancel.count()) {
      await cancel.click();
      await approve(page);
      await page.waitForTimeout(2000);
      await refresh(page);
      i = -1;
      continue;
    }
    await toggle.click();
    await page.waitForTimeout(300);
  }
}

/** Seller's collection profile + the taker's channel details (both private). */
const SELLER = { name: 'Zhang San', account: 'wxid_pay8888', price: '71.5', currency: 'CNY' };
const BUYER = { name: 'Demo Buyer', account: 'wxid_buyer01' };

/**
 * One full BIG → CNY WeChat settlement, with fresh wallets, shot in the given
 * wallet UI language. Returns the run facts for the report.
 */
async function captureRun(browser, lang) {
  const tag = `p2p-cny-${RAIL}`;
  const shotN = (n, who, page, sel) => shot(page, `${tag}-${String(n).padStart(2, '0')}-${who}-${lang}.png`, sel);
  const run = { rail: RAIL, lang, currency: SELLER.currency, price: SELLER.price, timeline: [] };
  const runAt = (step) => {
    at(`[${lang}] ${step}`);
    run.timeline.push(`${new Date().toISOString().slice(11, 19)}  ${step}`);
  };

  // 1. two fresh wallets (created in English, then the UI switches language)
  const seller = await createWallet(browser, `${lang}-seller`);
  const buyer = await createWallet(browser, `${lang}-buyer`);
  const s = seller.page;
  const b = buyer.page;
  await setLanguage(s, lang);
  await setLanguage(b, lang);
  runAt('both wallets created');

  // 2. seller: collection profile (screenshot 1) + the BIG/CNY ad (screenshot 2)
  await gotoP2P(s);
  await cleanupState(s);
  await el(s, 'p2p-tab-mine').click();
  await s.waitForTimeout(1000);
  await el(s, `p2p-profile-method-${RAIL}`).click();
  await el(s, 'p2p-profile-name').fill(SELLER.name);
  await el(s, 'p2p-profile-account').fill(SELLER.account);
  await el(s, 'p2p-profile-save').click();
  await approve(s);
  await s.waitForTimeout(1800);
  await shotN(1, 'profile', s, '[data-testid="p2p-profile-card"]');

  await el(s, 'p2p-give-token').fill('bc');
  await s.waitForTimeout(800);
  await el(s, 'p2p-give-amount').fill('10');
  await el(s, 'p2p-want-amount').fill(SELLER.price);
  await el(s, `p2p-rail-${RAIL}`).click();
  await s.waitForTimeout(300);
  await el(s, 'p2p-want-currency').fill(SELLER.currency);
  await s.waitForTimeout(400);
  await shotN(2, 'order', s, '[data-testid="p2p-order-side"]');
  await el(s, 'p2p-create').click();
  await approve(s);
  await s.waitForTimeout(2500);
  const listing = await el(s, 'p2p-notice').first().textContent().catch(() => null);
  if (!listing) throw new Error('order was not listed (no notice)');
  runAt('sell order listed: 10 bc → 715 CNY (wechat)');

  // 3. buyer: own channel details, then take the ad
  await gotoP2P(b);
  await el(b, 'p2p-tab-mine').click();
  await b.waitForTimeout(1000);
  await el(b, `p2p-profile-method-${RAIL}`).click();
  await el(b, 'p2p-profile-name').fill(BUYER.name);
  await el(b, 'p2p-profile-account').fill(BUYER.account);
  await el(b, 'p2p-profile-save').click();
  await approve(b);
  await b.waitForTimeout(1500);
  await el(b, 'p2p-tab-open').click();
  await b.waitForTimeout(800);
  await el(b, 'p2p-order-0-toggle').waitFor({ timeout: TIMEOUT });
  await el(b, 'p2p-order-0-toggle').click();
  await b.waitForTimeout(600);
  if (!buyer.address) throw new Error('could not read the buyer wallet address');
  await el(b, 'p2p-buy-recv').fill(buyer.address);
  await b.waitForTimeout(400);
  await shotN(3, 'match', b, '[data-testid="p2p-order-0"]');
  await actUntil(b, 'p2p-buy-confirm', 'MATCHED');
  await shotN(4, 'matched', b, '[data-testid="p2p-swap-0"]');
  runAt('buyer matched (receive address only)');

  // 4. seller locks with a synthetic funding hash (memory engine, no chain).
  //    The engine allows 10 signed calls/DID/60s; the seller is at its ceiling
  //    after profile + list + match, so let the window pass first.
  await sleep(70_000);
  runAt('paced 70 s past the rate-limit window');
  await el(s, 'p2p-tab-mine').click();
  await s.waitForTimeout(600);
  await refresh(s);
  await waitStatus(s, 'MATCHED');
  await el(s, 'p2p-swap-0-txhash').fill('ab'.repeat(32));
  await shotN(5, 'escrow-lock', s, '[data-testid="p2p-swap-0"]');
  await actUntil(s, 'p2p-swap-0-lock', ['ESCROW_LOCKED', 'PAYMENT_PENDING']);
  await shotN(6, 'escrow-locked', s, '[data-testid="p2p-swap-0"]');
  runAt('escrow lock recorded (ESCROW_LOCKED)');

  // 5. buyer: payment instructions (screenshots 7-8)
  await el(b, 'p2p-tab-mine').click();
  await b.waitForTimeout(600);
  await refresh(b);
  await waitStatus(b, 'ESCROW_LOCKED');
  await shotN(7, 'buy-locked', b, '[data-testid="p2p-swap-0"]');
  await el(b, 'p2p-swap-0-instructions').click();
  await approve(b);
  await el(b, 'p2p-swap-0-instructions-panel').waitFor({ timeout: TIMEOUT });
  await b.waitForTimeout(600);
  await shotN(8, 'instructions', b, '[data-testid="p2p-swap-0"]');
  const panel = await el(b, 'p2p-swap-0-instructions-panel').textContent();
  const remark = (panel.match(/Remark:\s*([0-9a-f]+)/) ?? [])[1] ?? '';
  runAt(`buyer pulled instructions (${remark ? `remark ${remark}` : 'remark'})`);

  // 6. buyer pays (fiat leg is out of band) and claims with the 流水号
  const txId = '4203' + randomBytes(8).toString('hex').slice(0, 12).toUpperCase();
  await el(b, 'p2p-swap-0-txid').fill(txId);
  await b.waitForTimeout(400);
  await shotN(9, 'payment-pending', b, '[data-testid="p2p-swap-0"]');
  await actUntil(b, 'p2p-swap-0-proof', 'PAYMENT_CLAIMED');
  await shotN(10, 'payment-claimed', b, '[data-testid="p2p-swap-0"]');
  runAt(`buyer claimed payment (${txId})`);

  // 7. seller confirms on their own statement
  await refresh(s);
  await waitStatus(s, 'PAYMENT_CLAIMED');
  await shotN(11, 'seller-confirm', s, '[data-testid="p2p-swap-0"]');
  await actUntil(s, 'p2p-swap-0-confirm', ['PAYMENT_VERIFIED', 'ESCROW_RELEASED', 'COMPLETED']);
  await shotN(12, 'payment-verified', s, '[data-testid="p2p-swap-0"]');
  runAt('seller confirmed receipt (PAYMENT_VERIFIED)');

  // 8. engine signs release + complete (what the production signer does)
  const swapId = (await el(b, 'p2p-swap-0').textContent()).match(/swap-[0-9a-f]{16}/)[0];
  const release = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'release', txHash: 'cd'.repeat(32) }));
  if (release.status !== 'ESCROW_RELEASED') throw new Error(`release → ${release.status}`);
  await refresh(b);
  await waitStatus(b, ['ESCROW_RELEASED', 'COMPLETED']);
  await shotN(13, 'escrow-released', b, '[data-testid="p2p-swap-0"]');
  runAt('engine signed the release (ESCROW_RELEASED)');

  const complete = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'complete' }));
  if (complete.status !== 'COMPLETED') throw new Error(`complete → ${complete.status}`);
  await refresh(b);
  await waitStatus(b, 'COMPLETED');
  await shotN(14, 'completed', b, '[data-testid="p2p-swap-0"]');
  runAt('swap completed (COMPLETED)');

  Object.assign(run, { swapId, txId, remark, engineDid, capturedAt: new Date().toISOString() });
  await seller.context.close();
  await buyer.context.close();
  return run;
}

async function main() {
  console.log(`engine DID: ${engineDid.slice(0, 46)}… (ML-DSA-87)`);
  console.log(`languages: ${LANGS.join(', ')}`);
  startServers();
  await waitHealth(`${ENGINE}/healthz`);
  await waitHealth(APP, 60000);
  at('engine + wallet web app up');

  const browser = await chromium.launch({ headless: true });
  const runs = [];
  try {
    for (const lang of LANGS) {
      console.log(`\n━━━ ${lang} ━━━`);
      runs.push(await captureRun(browser, lang));
    }
  } finally {
    await browser.close();
  }

  const report = {
    engineDid,
    rail: RAIL,
    languages: LANGS,
    runs: runs.map((r) => ({
      lang: r.lang,
      swapId: r.swapId,
      txId: r.txId,
      remark: r.remark,
      capturedAt: r.capturedAt,
    })),
    timeline,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(HERE, 'demo-output/p2p-cny-capture.json'), JSON.stringify(report, null, 2));
  console.log(`\nwrote e2e/demo-output/p2p-cny-capture.json (${runs.map((r) => `${r.lang}=${r.swapId}`).join(' ')})`);
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
