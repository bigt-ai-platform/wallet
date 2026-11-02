#!/usr/bin/env node
/**
 * Capture the P2P demo on the **Android app** (Chinese UI), funds-free.
 *
 * - starts a local p2p-engine (memory store, no chain client) on :18089 and
 *   reverses it into the phone;
 * - drives the installed demo APK (built with EXPO_PUBLIC_P2P_ENGINE_URL and
 *   EXPO_PUBLIC_E2E_AUTOCONFIRM) through a full BIG → fiat settlement using two
 *   plain demo wallets (seller/buyer), switching them in the app;
 * - writes the screenshots the PDF guide references
 *   (docs/p2p-demo/assets/screenshots/<PREFIX>-NN-*-<LANG>.png);
 * - backs up the device's real wallet before touching it and restores it in
 *   `finally` (the encrypted blob is copied as-is; no password needed).
 *
 * Rates: BIG/fiat = PRICE → the ad sells GIVE BIG for GIVE × PRICE fiat.
 * Defaults: WeChat/CNY, 10,000 BIG → 100 CNY at 0.01.
 *
 * Usage (after building/installing the demo APK):
 *   node e2e/capture-p2p-android-cny.mjs
 *   RAIL=paypal CURRENCY=USD PREFIX=p2p-paypal \
 *     SELLER_ACCOUNT=seller@example.com BUYER_ACCOUNT=buyer@example.com \
 *     node e2e/capture-p2p-android-cny.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Address, MainNetParams, PQKey, Sha256Hash, Utils } from 'bigtangle-ts';
import { didFromPQKey } from 'did/pq';

const ROOT = resolve(import.meta.dirname, '..');
const ADB = process.env.ADB || `${process.env.HOME}/android-sdk/platform-tools/adb`;
const ENGINE_PORT = Number(process.env.P2P_PORT || 18089);
const CDP_PORT = Number(process.env.CDP_PORT || 9445);
const SHOTS = resolve(ROOT, 'docs/p2p-demo/assets/screenshots');
const BACKUP = '/tmp/opencode/wallet-android-demo-backup.json';
const DEMO_WALLETS = '/tmp/opencode/wallet-android-demo-wallets.json';
const PRICE = process.env.PRICE || '0.01'; // fiat per BIG
const GIVE = process.env.GIVE || '10000'; // BIG
const CURRENCY = process.env.CURRENCY || 'CNY';
const WANT = String(Number(GIVE) * Number(PRICE)); // fiat = GIVE × PRICE
const RAIL = process.env.RAIL || 'wechat';
const LANG = process.env.LANG_TAG || 'zh';
// Success notices the app shows, used to wait for a save/publish.
const NOTICE_SAVED = LANG === 'en' ? 'Profile saved' : '已保存';
const NOTICE_LISTED = LANG === 'en' ? 'Order listed' : '已发布';
const PREFIX = process.env.PREFIX || `p2p-cny-${RAIL}`;
// PayPal accounts are emails; the CNY rails use their own ids.
const SELLER_NAME = process.env.SELLER_NAME || '张三';
const BUYER_NAME = process.env.BUYER_NAME || '李四';
const SELLER_ACCOUNT = process.env.SELLER_ACCOUNT || 'wxid_pay8888';
const BUYER_ACCOUNT = process.env.BUYER_ACCOUNT || 'wxid_buyer01';
const shotName = (name) => `${PREFIX}-${name}-${LANG}.png`;
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log('·', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

// ── engine ──────────────────────────────────────────────────────────────────
const engineKey = PQKey.createNewKey();
const engineSeed = engineKey.getPrivateKeySeedAsHex();
const engineDid = didFromPQKey(engineKey);
const enginePubHex = Utils.HEX.encode(engineKey.getPrefixedPublicKeyBytes());
let engine;

function waitHealth(url, ms = 20000) {
  const t0 = Date.now();
  return (async () => {
    for (;;) {
      try {
        const r = await fetch(url);
        if (r.ok) return;
      } catch {}
      if (Date.now() - t0 > ms) throw new Error(`engine not reachable: ${url}`);
      await sleep(250);
    }
  })();
}

function canonSign(fields) {
  const payload = {
    ...fields,
    requestMethod: 'POST',
    requestPath: `/swaps/${fields.swapId}/transitions`,
    did: engineDid,
    nonce: randomBytes(8).toString('hex'),
    timestamp: Date.now(),
  };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonical));
  const signature = Utils.HEX.encode(engineKey.sign(Sha256Hash.wrap(digest)).serialize());
  return { ...payload, signature };
}

async function api(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${data.error || ''}`);
  return data;
}

// ── demo wallets ────────────────────────────────────────────────────────────
function wallet(seedByte) {
  const key = PQKey.fromMLDSA(new Uint8Array(32).fill(seedByte));
  return {
    address: Address.fromP2PKH(MainNetParams.get(), key.getPubKeyHash()).toBase58(),
    pubkey: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
    privateKey: key.getPrivateKeyHex(),
    keyType: 'PQ',
  };
}
const seller = wallet(0xa1);
const buyer = wallet(0xa2);
function walletJson(w) {
  return JSON.stringify({ keys: [w] });
}

// ── CDP ─────────────────────────────────────────────────────────────────────
let ws;
let nextId = 1;
const pending = new Map();
let pageEnabled = false;

async function connectCdp() {
  // forward the current WebView devtools socket
  const sockLine = adb('shell', 'cat', '/proc/net/unix');
  const sock = (sockLine.match(/webview_devtools_remote_\d+/g) || []).pop();
  if (!sock) throw new Error('no webview_devtools_remote socket');
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = list.find((p) => p.type === 'page' && /localhost/.test(p.url)) || list.find((p) => p.type === 'page');
  if (!page) throw new Error('no devtools page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  await send('Page.enable');
  pageEnabled = true;
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
  }
  return r.result?.value;
}

async function shot(name, selector) {
  if (selector) {
    await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.scrollIntoView({ block: 'center' }); return !!el; })()`);
    await sleep(500);
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(SHOTS, name), Buffer.from(r.data, 'base64'));
  log('shot', name);
}

async function waitFor(expr, timeout = 20000, label = expr) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await evalJs(expr); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(300);
  }
}

const q = (id) => `document.querySelector('[data-testid="${id}"]')`;
async function click(id, timeout = 12000) {
  await waitFor(`!!${q(id)}`, timeout, `click ${id}`);
  await evalJs(`${q(id)}.click()`);
  await sleep(250);
}
async function fill(id, value, timeout = 12000) {
  await waitFor(`!!${q(id)}`, timeout, `fill ${id}`);
  await evalJs(`(() => {
    const el = ${q(id)};
    const proto = el.ownerDocument.defaultView[el.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement'].prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(200);
}
async function text(id) {
  return evalJs(`(${q(id)}?.innerText || ${q(id)}?.value || '')`);
}
async function bodyText() {
  return evalJs(`(document.body.innerText || '')`);
}

async function setWallet(w, language = 'zh') {
  await evalJs(`(() => {
    localStorage.setItem('device.walletEncryptedContent', ${JSON.stringify(walletJson(w))});
    localStorage.setItem('device.walletAddress', ${JSON.stringify(w.address)});
    localStorage.setItem('settings.language', ${JSON.stringify(language)});
    location.reload();
  })()`);
  await sleep(3500);
  await waitFor(`document.readyState === 'complete' && !!document.body`, 15000, 'reload');
  await sleep(1500);
}

async function goP2P() {
  // open the drawer (bottom menu) then the P2P nav row
  const menu = await evalJs(`!!${q('nav-menu')}`);
  if (menu) {
    await click('nav-menu');
    await sleep(500);
  }
  const ok = await evalJs(`(() => {
    const el = [...document.querySelectorAll('[role="button"],button')]
      .find((e) => (e.getAttribute('aria-label') || '').trim() === 'P2P' || (e.innerText || '').trim() === 'P2P');
    if (!el) return false; el.click(); return true;
  })()`);
  if (!ok) throw new Error('P2P nav not found');
  await sleep(1800);
  const locked = await evalJs(`!!${q('p2p-need-unlock')} && !document.querySelector('[data-testid="p2p-tab-open"]')`);
  if (locked) throw new Error('P2P screen is locked — demo wallet did not unlock');
  await waitFor(`!!${q('p2p-tab-open')}`, 20000, 'P2P screen');
}

async function waitSwapStatus(statuses, timeout = 25000) {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  await waitFor(`(${q('p2p-swap-0-status')}?.getAttribute('data-status') || '') && ${JSON.stringify(list)}.includes(${q('p2p-swap-0-status')}.getAttribute('data-status').trim())`, timeout, `swap ${list}`);
}

async function refresh() {
  await click('p2p-refresh').catch(() => {});
  await sleep(1500);
}

// ── capture flow ────────────────────────────────────────────────────────────
let backup = null;
async function saveBackup() {
  const raw = await evalJs(`JSON.stringify({
    wallet: localStorage.getItem('device.walletEncryptedContent'),
    address: localStorage.getItem('device.walletAddress'),
    language: localStorage.getItem('settings.language'),
  })`);
  backup = JSON.parse(raw);
  writeFileSync(BACKUP, raw);
  chmodSync(BACKUP, 0o600);
  if (!backup.wallet) throw new Error('device wallet backup is empty — aborting before replacing it');
  log(`wallet backed up (${backup.wallet.length} bytes) → ${BACKUP}`);
}

async function restoreBackup() {
  if (!backup) return;
  await evalJs(`(() => {
    ${backup.wallet ? `localStorage.setItem('device.walletEncryptedContent', ${JSON.stringify(backup.wallet)});` : ''}
    ${backup.address ? `localStorage.setItem('device.walletAddress', ${JSON.stringify(backup.address)});` : ''}
    ${backup.language ? `localStorage.setItem('settings.language', ${JSON.stringify(backup.language)});` : `localStorage.removeItem('settings.language');`}
    location.reload();
  })()`).catch(() => {});
  await sleep(2000);
  log('device wallet restored');
}

async function main() {
  // 1. engine + reverse
  engine = spawn('node', [resolve(ROOT, 'services/p2p-engine/dist/server.bundle.mjs')], {
    env: {
      ...process.env,
      PORT: String(ENGINE_PORT),
      HOST: '127.0.0.1',
      SETTLEMENT_STORE: 'mem',
      SETTLEMENT_ADMIN_TOKEN: 'adm',
      SETTLEMENT_ENGINE_DID: engineDid,
      SETTLEMENT_ENGINE_KEY: engineSeed,
      SETTLEMENT_ESCROW_KEY: engineSeed,
      SETTLEMENT_ENGINE_PUBKEY: enginePubHex,
      SETTLEMENT_FIAT_RAILS: RAIL,
      SETTLEMENT_CNY_RAILS: RAIL,
      CORS_ORIGIN: 'http://localhost,http://127.0.0.1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  engine.stderr.on('data', (d) => process.stderr.write(`[engine] ${d}`));
  await waitHealth(`http://127.0.0.1:${ENGINE_PORT}/healthz`);
  adb('reverse', `tcp:${ENGINE_PORT}`, `tcp:${ENGINE_PORT}`);
  log(`engine up on :${ENGINE_PORT}, reversed into the phone`);

  // 2. app + backup
  adb('shell', 'am', 'start', '-n', 'ai.bigt.wallet/.MainActivity');
  await sleep(4000);
  await connectCdp();
  await saveBackup();

  // 3. seller: profile + ad
  await setWallet(seller, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await click(`p2p-profile-method-${RAIL}`);
  await fill('p2p-profile-name', SELLER_NAME);
  await fill('p2p-profile-account', SELLER_ACCOUNT);
  await click('p2p-profile-save');
  await waitFor(`(${q('p2p-notice')}?.innerText || '').includes(${JSON.stringify(NOTICE_SAVED)})`, 15000, 'profile saved');
  await shot(shotName('01-profile'));

  await click('p2p-side-sell');
  await fill('p2p-give-token', 'bc');
  await fill('p2p-give-amount', GIVE);
  await fill('p2p-want-amount', PRICE);
  await click(`p2p-rail-${RAIL}`);
  await fill('p2p-want-currency', CURRENCY);
  await sleep(500);
  const total = await text('p2p-total');
  log(`ad form total: ${total}`);
  if (!total.includes(WANT)) throw new Error(`unexpected total "${total}" (want ${WANT})`);
  await shot(shotName('02-order'));
  await click('p2p-create');
  await waitFor(`(${q('p2p-notice')}?.innerText || '').includes(${JSON.stringify(NOTICE_LISTED)})`, 20000, 'order listed');
  log('sell order listed');

  // 4. buyer: own private channel details, then match
  await setWallet(buyer, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await click(`p2p-profile-method-${RAIL}`);
  await fill('p2p-profile-name', BUYER_NAME);
  await fill('p2p-profile-account', BUYER_ACCOUNT);
  await click('p2p-profile-save');
  await waitFor(`(${q('p2p-notice')}?.innerText || '').includes(${JSON.stringify(NOTICE_SAVED)})`, 15000, 'buyer profile saved');
  await click('p2p-tab-open');
  await waitFor(`!!${q('p2p-order-0-toggle')}`, 20000, 'buyer book');
  await click('p2p-order-0-toggle');
  await sleep(500);
  await fill('p2p-buy-recv', buyer.address);
  await sleep(300);
  await shot(shotName('03-match'));
  await click('p2p-buy-confirm');
  await sleep(3500);
  console.log('  buyer notice:', await text('p2p-notice'));
  console.log('  buyer tail:', (await bodyText()).slice(-900).replace(/\n/g, ' | '));
  await waitFor(`!!${q('p2p-swap-0')}`, 20000, 'swap created');
  await waitSwapStatus('MATCHED');
  await shot(shotName('04-matched'), '[data-testid="p2p-swap-0"]');
  log('buyer matched');

  // 5. seller: escrow lock
  await setWallet(seller, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await waitFor(`!!${q('p2p-swap-0-txhash')}`, 20000, 'seller swap MATCHED');
  await fill('p2p-swap-0-txhash', 'ab'.repeat(32));
  await shot(shotName('05-escrow-lock'), '[data-testid="p2p-swap-0"]');
  await click('p2p-swap-0-lock');
  await waitSwapStatus('ESCROW_LOCKED');
  await shot(shotName('06-escrow-locked'), '[data-testid="p2p-swap-0"]');
  log('escrow lock recorded');

  // 6. buyer: instructions + proof
  await setWallet(buyer, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await waitSwapStatus('ESCROW_LOCKED');
  await shot(shotName('07-buy-locked'), '[data-testid="p2p-swap-0"]');
  await click('p2p-swap-0-instructions');
  await waitFor(`!!${q('p2p-swap-0-instructions-panel')}`, 20000, 'instructions');
  await sleep(500);
  await shot(shotName('08-instructions'), '[data-testid="p2p-swap-0-instructions-panel"]');
  const txId = '4203' + randomBytes(8).toString('hex').slice(0, 12).toUpperCase();
  await fill('p2p-swap-0-txid', txId);
  await sleep(300);
  await shot(shotName('09-payment-pending'), '[data-testid="p2p-swap-0"]');
  await click('p2p-swap-0-proof');
  await waitSwapStatus('PAYMENT_CLAIMED');
  await shot(shotName('10-payment-claimed'), '[data-testid="p2p-swap-0"]');
  log(`buyer claimed payment (${txId})`);

  // 7. seller: confirm
  await setWallet(seller, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await waitSwapStatus('PAYMENT_CLAIMED');
  await shot(shotName('11-seller-confirm'), '[data-testid="p2p-swap-0"]');
  await click('p2p-swap-0-confirm');
  await waitSwapStatus(['PAYMENT_VERIFIED', 'ESCROW_RELEASED', 'COMPLETED']);
  await shot(shotName('12-payment-verified'), '[data-testid="p2p-swap-0"]');
  log('seller confirmed receipt');

  // 8. engine stand-in release + complete (no chain in the funds-free demo)
  const swapId = (await text('p2p-swap-0')).match(/swap-[0-9a-f]{16}/)[0];
  const release = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'release', txHash: 'cd'.repeat(32) }));
  if (release.status !== 'ESCROW_RELEASED') throw new Error(`release → ${release.status}`);
  const complete = await api(`/swaps/${swapId}/transitions`, canonSign({ swapId, action: 'complete' }));
  if (complete.status !== 'COMPLETED') throw new Error(`complete → ${complete.status}`);
  log(`settled ${swapId}`);

  // 9. buyer: released + completed
  await setWallet(buyer, LANG);
  await goP2P();
  await click('p2p-tab-mine');
  await waitSwapStatus(['ESCROW_RELEASED', 'COMPLETED']);
  await shot(shotName('13-escrow-released'), '[data-testid="p2p-swap-0"]');
  await waitSwapStatus('COMPLETED');
  await shot(shotName('14-completed'), '[data-testid="p2p-swap-0"]');
  log('completed');
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  console.error('capture failed:', e?.message || e);
  try {
    console.error('  page tail:', (await bodyText()).slice(-1200).replace(/\n/g, ' | '));
    await shot(shotName('99-debug-failure'));
  } catch {}
} finally {
  try { await restoreBackup(); } catch (e) { console.error('restore failed:', e?.message || e); }
  try { adb('reverse', '--remove', `tcp:${ENGINE_PORT}`); } catch {}
  try { adb('forward', '--remove', `tcp:${CDP_PORT}`); } catch {}
  try { engine?.kill('SIGTERM'); } catch {}
}
process.exit(exitCode);
