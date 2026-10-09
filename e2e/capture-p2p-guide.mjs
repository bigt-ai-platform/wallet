#!/usr/bin/env node
/**
 * Capture the wallet-native P2P settlement flow (the P2pScreen UI) as the
 * numbered screenshots the help guide embeds:
 *   docs/p2p-demo/assets/screenshots/p2p-NN-<lang>.png
 *
 * This replaces the removed dai-agent flow the old guide described. It drives
 * the real P2pScreen over the PayPal rail, end to end:
 *   seller lists → order ACTIVE → buyer matches → seller locks the 2-of-3
 *   escrow → buyer reports the payment → engine verifies → release → complete.
 *
 * Self-contained: starts the p2p-engine (mem store, insecure PayPal, no chain
 * check) with a generated engine DID, serves e2e/web-build, and drives a fresh
 * seller + buyer wallet through the flow. The lock/verify/release/complete legs
 * are signed with the engine key, exactly what the production engine signer
 * does after its own evidence.
 *
 * The UI language is switched per run via the i18n instance the app exposes on
 * the web bundle (`globalThis.__bigtangleI18n`, see expo-app/sources/lib/i18n.ts)
 * so every screenshot is localized.
 *
 * Usage (from the repo root, after `expo-app` web:build):
 *   node e2e/capture-p2p-guide.mjs                      # English
 *   CAPTURE_LANGS=zh node e2e/capture-p2p-guide.mjs     # one language
 *   CAPTURE_LANGS=en,zh,de node e2e/capture-p2p-guide.mjs  # several, one engine each
 *   KEEP=1 node e2e/capture-p2p-guide.mjs               # leave the servers running
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
const PWD = 'P2pDemoPass123!';
const TIMEOUT = 30000;
// NB: not `LANG` — that collides with the POSIX locale (e.g. en_US.UTF-8).
const LANGS = (process.env.CAPTURE_LANGS || 'en').split(',').map((s) => s.trim()).filter(Boolean);
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

/** A leftover engine from an earlier run would not know our engine DID. */
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
      CORS_ORIGIN: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stdout.on('data', (d) => process.env.CAPTURE_VERBOSE && process.stdout.write(`[engine] ${d}`));
  engine.stderr.on('data', (d) => process.stdout.write(`[engine] ${d}`));
  children.push(engine);

  if (!listen(WEB_PORT)) {
    const web = spawn(resolve(ROOT, 'node_modules/.bin/http-server'), [resolve(ROOT, 'e2e/web-build'), '-p', String(WEB_PORT), '--silent'], {
      stdio: 'ignore',
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
  if (d) await d.saveAs(`/tmp/p2p-guide-${name}-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
  return { context, page };
}

/** Switch the running app to `lang` via the i18n instance it exposes. */
async function setLang(page, lang) {
  if (lang === 'en') return;
  const ok = await page
    .evaluate((l) => {
      const i = globalThis.__bigtangleI18n;
      if (i && typeof i.changeLanguage === 'function') return i.changeLanguage(l).then(() => true);
      return false;
    }, lang)
    .catch(() => false);
  if (!ok) throw new Error(`could not switch language to ${lang}`);
  await page.waitForTimeout(900);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runFlow(browser, lang) {
  const sfx = `-${lang}`;
  // ── 1. seller lists USDT for USD via PayPal ─────────────────────────────
  const seller = await createWallet(browser, `seller-${lang}`);
  const buyer = await createWallet(browser, `buyer-${lang}`);
  at(`[${lang}] both wallets created`);

  const s = seller.page;
  await openNav(s, 'P2P');
  await setLang(s, lang);
  await el(s, 'p2p-tab-open').click();
  await s.waitForTimeout(600);
  await el(s, 'p2p-give-token').fill('USDT');
  await el(s, 'p2p-give-amount').fill('10');
  await el(s, 'p2p-want-amount').fill('10.10');
  await el(s, 'p2p-want-currency').fill('USD');
  await el(s, 'p2p-rail-paypal').click();
  await s.waitForTimeout(400);
  await shot(s, `p2p-01-order${sfx}.png`);
  await el(s, 'p2p-create').click();
  await s.waitForTimeout(1500);
  // submitOrder lands on "My swaps" (empty until matched); show the live order
  // in the public book instead.
  await el(s, 'p2p-tab-open').click();
  await s.waitForTimeout(600);
  await refresh(s);
  await shot(s, `p2p-02-active${sfx}.png`);
  at(`[${lang}] sell order listed (wantRail=paypal, 10.10 USD)`);

  // ── 2. buyer matches (receive address + PayPal account/email) ──────────
  const b = buyer.page;
  await openNav(b, 'P2P');
  await setLang(b, lang);
  await el(b, 'p2p-order-0').waitFor({ timeout: TIMEOUT });
  await el(b, 'p2p-buy-0').click();
  await el(b, 'p2p-buy-recv').fill('BP2pDemoBuyerReceiveAddress');
  await el(b, 'p2p-buy-paypal').fill('buyer@example.com');
  await el(b, 'p2p-buy-email').fill('buyer@example.com');
  await b.waitForTimeout(400);
  await shot(b, `p2p-03-match${sfx}.png`);
  await el(b, 'p2p-buy-confirm').click();
  await waitForStatus(b, 'MATCHED');
  await shot(b, `p2p-04-matched${sfx}.png`);
  at(`[${lang}] buyer matched`);

  // ── 3. seller locks the 2-of-3 escrow ──────────────────────────────────
  // The engine caps signed calls per DID (10/60s); the seller's load-refresh
  // calls are already at the ceiling, so pace past the window before locking.
  await sleep(65000);
  await el(s, 'p2p-tab-mine').click();
  await s.waitForTimeout(600);
  await refresh(s);
  await waitForStatus(s, 'MATCHED');
  await el(s, 'p2p-swap-0-txhash').fill('ab'.repeat(32));
  await el(s, 'p2p-swap-0-lock').click();
  await waitForStatus(s, 'ESCROW_LOCKED');
  await shot(s, `p2p-05-escrow-locked${sfx}.png`);
  at(`[${lang}] escrow lock recorded (ESCROW_LOCKED)`);

  // ── 4. buyer sees the lock and reports the PayPal payment ──────────────
  await refresh(b);
  await waitForStatus(b, 'ESCROW_LOCKED');
  await shot(b, `p2p-06-buyer-locked${sfx}.png`);
  await el(b, 'p2p-swap-0-pay').click();
  await waitForStatus(b, 'PAYMENT_PENDING');
  await shot(b, `p2p-07-payment-pending${sfx}.png`);
  at(`[${lang}] buyer reported payment (PAYMENT_PENDING)`);

  // ── 5. engine verifies, releases and completes (production signer) ─────
  const swapId = (await el(b, 'p2p-swap-0').textContent()).match(/swap-[0-9a-f]{16}/)[0];
  const verify = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'verify' }));
  if (verify.status !== 'PAYMENT_VERIFIED') throw new Error(`verify → ${verify.status}`);
  await refresh(b);
  await waitForStatus(b, 'PAYMENT_VERIFIED');
  await shot(b, `p2p-08-payment-verified${sfx}.png`);

  const release = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'release', txHash: 'cd'.repeat(32) }));
  if (release.status !== 'ESCROW_RELEASED') throw new Error(`release → ${release.status}`);
  await refresh(b);
  await waitForStatus(b, 'ESCROW_RELEASED');
  await shot(b, `p2p-09-escrow-released${sfx}.png`);

  // PayPal swaps finish via the (engine-signed) payout leg, not `complete`.
  const payout = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'payout' }));
  if (payout.status !== 'COMPLETED') throw new Error(`payout → ${payout.status}`);
  await refresh(b);
  await waitForStatus(b, 'COMPLETED');
  await shot(b, `p2p-10-completed${sfx}.png`);
  at(`[${lang}] swap completed (COMPLETED)`);

  await seller.context.close();
  await buyer.context.close();
  return { engineDid, swapId };
}

async function main() {
  console.log(`engine DID: ${engineDid.slice(0, 46)}… (ML-DSA-87, ${engineDid.length} chars)`);
  console.log(`languages: ${LANGS.join(', ')}`);
  startServers();
  await waitHealth(`${ENGINE}/healthz`);
  await waitHealth(APP, 60000);
  at('engine + wallet web app up');

  const browser = await chromium.launch({ headless: true });
  try {
    const report = [];
    for (const lang of LANGS) {
      // Clean engine state per language so p2p-order-0 is always this run's.
      report.push(await runFlow(browser, lang));
      if (LANGS.indexOf(lang) < LANGS.length - 1) {
        freePort(ENGINE_PORT);
        startServers();
        await waitHealth(`${ENGINE}/healthz`);
      }
    }
    writeFileSync(resolve(HERE, 'demo-output/p2p-guide-capture.json'), JSON.stringify({ report, timeline, capturedAt: new Date().toISOString() }, null, 2));
    console.log('\nTimeline:');
    for (const line of timeline) console.log(`  ${line}`);
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
