#!/usr/bin/env node
/**
 * Capture the P2P CNY settlement flow against the LIVE deployment
 * (https://wallet.bigt.ai) — real prod engine, real L0 escrow.
 *
 * Difference from capture-p2p-cny.mjs (the local demo build): nothing is
 * started here. The wallet web app and the settlement engine are the deployed
 * ones, and the escrow legs are REAL mainnet BIG:
 *
 *   - the seller key is funded from a prod validator keystore
 *     (../blockchain/helper/prod/validators/SendFromKeystore.java);
 *   - the seller's key funds the 2-of-3 P2SH vault with `BIG_UNITS` of BIG
 *     (the same `payToScript` the wallet would use) — the engine only accepts
 *     the escrow after `verifyChainLock` sees it CONFIRMED on L0;
 *   - the engine's settlement hook releases the escrow to the buyer's own
 *     address after the seller confirms.
 *
 * Only BIG exists on prod L0 today, so the ad is quoted in BIG (`bc`) — the
 * amount is in whole BIG and the unit price in CNY.
 *
 * *** THIS SPENDS REAL FUNDS. It is an operator tool, never the demo path. ***
 * The demo/PDF pipeline is the no-funds harness (`./p2pdemo.sh capture
 * walkthrough` → e2e/capture-p2p-cny.mjs): a memory engine, synthetic tx hashes,
 * nothing leaves any wallet. This script exists only for an operator who
 * explicitly wants a production-escrow capture.
 *
 * It refuses to run unless ALLOW_REAL_FUNDS=1 is set.
 *
 * Usage:  ALLOW_REAL_FUNDS=1 RAILS=wechat node capture-p2p-prod.mjs
 *         DRY_RUN=1 node capture-p2p-prod.mjs        # no funds (listing form stops)
 */
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Address, Coin, Escrow, MainNetParams, PQKey, Sha256Hash, Utils, Wallet } from 'bigtangle-ts';
import { didFromPQKey } from 'did/pq';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const APP = (process.env.APP_URL || 'https://wallet.bigt.ai').replace(/\/+$/, '') + '/';
const L0 = (process.env.L0_URL || 'https://eu1.bigtangle.org').replace(/\/+$/, '') + '/';
const ENGINE = (process.env.ENGINE_URL || `${APP}p2p`).replace(/\/+$/, '');
const SHOTS = process.env.SHOTS_DIR
  ? resolve(process.env.SHOTS_DIR)
  : resolve(ROOT, 'docs/p2p-demo/assets/screenshots');
const PWD = 'CnyDemoPass123!';
const TIMEOUT = 90_000;
const DRY_RUN = process.env.DRY_RUN === '1';
/** Hard stop: this script funds a production wallet and locks a real escrow. */
const ALLOW_REAL_FUNDS = process.env.ALLOW_REAL_FUNDS === '1';
const RAILS = (process.env.RAILS || 'wechat,alipay,bank').split(',').map((r) => r.trim()).filter(Boolean);
/** 10 BIG in base units (BIG has 6 decimals on the prod chain params). */
const BIG_UNITS = BigInt(process.env.BIG_UNITS || '10000000');
/** Fund the seller with 30 BIG: 10 goes into the vault, and the engine's
 *  advisory balance gate still requires the seller to *hold* the advertised
 *  10 BIG when the ad is posted (a listing is not funded). */
const FUND_UNITS = BigInt(process.env.FUND_UNITS || '30000000');
mkdirSync(SHOTS, { recursive: true });

// ── prod funding (validator keystore → fresh seller key) ───────────────────
const KEYDIR = process.env.KEYDIR || '/home/jcui/keys/validators';
const CHAIN = process.env.CHAIN_ROOT || resolve(ROOT, '..', 'blockchain');
const SRC_STORE = process.env.SRC_STORE || resolve(KEYDIR, process.env.SRC_KEY || 'l0-2-keystore.json');
const MASTER_PW = process.env.MASTER_PASSWORD_FILE || resolve(KEYDIR, 'pass.txt');
const JAVA = process.env.JAVA_BIN || '/home/jcui/.local/java-25/bin/java';

function classpath() {
  const dir = resolve(CHAIN, 'target', 'fund-test-cp');
  if (!existsSync(resolve(dir, 'BOOT-INF', 'classes'))) {
    throw new Error(`missing ${dir} — run ../blockchain/helper/prod/fund-test-wallets.sh once to unpack the exec jar`);
  }
  return `${dir}/BOOT-INF/classes:${dir}/BOOT-INF/lib/*`;
}

/** Decrypt the validator keystore's password with the master password. */
function keystorePassword() {
  const enc = SRC_STORE.replace(/-keystore\.json$/, '-pass.enc');
  const out = resolve('/tmp', `p2p-prod-pass-${process.pid}`);
  rmSync(out, { force: true });
  execFileSync('openssl', [
    'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-md', 'sha256',
    '-pass', `file:${MASTER_PW}`, '-in', enc, '-out', out,
  ], { stdio: 'pipe' });
  return out;
}

function fundSeller(key) {
  const hash = Utils.HEX.encode(key.getPubKeyHash());
  const pw = keystorePassword();
  try {
    const out = execFileSync(JAVA, [
      '-cp', classpath(), resolve(CHAIN, 'helper/prod/validators/SendFromKeystore.java'),
      SRC_STORE, pw, hash, String(FUND_UNITS), L0,
    ], { stdio: 'pipe', timeout: 180_000 }).toString();
    const txid = (out.match(/^TXID=(.+)$/m) ?? [])[1];
    return { txid, hash };
  } finally {
    rmSync(pw, { force: true });
  }
}

// ── chain helpers (mainnet SDK against the prod L0 API) ────────────────────
function walletFor(keys) {
  const w = Wallet.fromKeysURL(MainNetParams.get(), keys, L0);
  w.setServerURL(L0);
  return w;
}

async function waitBalance(key, units, ms = 300_000) {
  const w = walletFor([key]);
  const t0 = Date.now();
  for (;;) {
    const c = await w.calculateAllSpendCandidates(null, false).catch(() => []);
    const big = c
      .filter((x) => x.getUTXO()?.getTokenId() === 'bc')
      .reduce((a, x) => a + (x.getUTXO()?.getValue()?.getValue() ?? 0n), 0n);
    if (big >= units) return big;
    if (Date.now() - t0 > ms) throw new Error(`balance timeout: ${big} < ${units} BIG units`);
    await sleep(5000);
  }
}

async function waitTxConfirmed(txHash, ms = 300_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${L0}getTransactionStatus`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.status === 'CONFIRMED') return j;
      if (j.status === 'UNKNOWN' && Date.now() - t0 > ms) throw new Error(`tx ${txHash} UNKNOWN`);
    } catch (e) { /* keep polling */ }
    if (Date.now() - t0 > ms) throw new Error(`tx ${txHash} not confirmed in ${ms}ms`);
    await sleep(5000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (page, id) => page.locator(`[data-testid="${id}"]`);
const log = (...a) => console.log(...a);

/** Pages that just hit the engine's L1-SOCIAL anchor contention (500). */
const anchorBusyAt = new WeakMap();
const ANCHOR_BUSY = /insufficient spendable outputs for social tx/i;

/** Canonical signed body — the exact envelope `signedBody` in the app sends. */
function signedBody(key, did, fields) {
  const payload = {
    ...fields,
    requestMethod: 'POST',
    did,
    nonce: randomBytes(8).toString('hex'),
    timestamp: Date.now(),
  };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonical));
  return { ...payload, signature: Utils.HEX.encode(key.sign(Sha256Hash.wrap(digest)).serialize()) };
}

async function engineCall(key, did, path, fields = {}) {
  const res = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signedBody(key, did, { requestPath: path, ...fields })),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error || ''}`);
  return data;
}

/** Close swaps an interrupted earlier run left open for this key pair. */
async function cleanupRail(sellerKey, buyerKey) {
  for (const key of [sellerKey, buyerKey]) {
    const did = didFromPQKey(key);
    let swaps = [];
    try { swaps = (await engineCall(key, did, '/swaps/mine')).swaps ?? []; } catch (e) {
      log(`  /swaps/mine failed for ${did.slice(0, 24)}…: ${String(e).slice(0, 160)}`);
      continue;
    }
    for (const sw of swaps) {
      if (!['MATCHED', 'ESCROW_LOCKED', 'PAYMENT_PENDING', 'PAYMENT_CLAIMED'].includes(sw.status)) continue;
      try {
        await engineCall(key, did, `/swaps/${sw.swapId}/transitions`, { swapId: sw.swapId, action: 'cancel' });
        log(`  cancelled stale swap ${sw.swapId} (${sw.status})`);
      } catch (e) {
        log(`  stale swap ${sw.swapId} not cancellable: ${String(e).slice(0, 120)}`);
      }
    }
  }
}

/** An unspent, confirmed output already holding this vault's escrow amount. */
async function findVaultLock(escrowAddress, vault, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${L0}getOutputsHistory`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromaddress: '', toaddress: escrowAddress, starttime: null, endtime: null }),
      });
      const j = await res.json();
      const hit = (j.outputs ?? []).find(
        (o) => o.spent !== true && o.confirmed !== false
          && (o.tokenId ?? o.tokenid) === 'bc'
          && BigInt(o.value?.value ?? 0) >= BIG_UNITS,
      );
      if (hit?.hashHex) return hit.hashHex;
    } catch { /* keep polling */ }
    if (Date.now() - t0 > ms) return null;
    await sleep(3000);
  }
}

/** Demo keys are persisted BEFORE any funds move — a crashed run must stay
 *  recoverable (the freed escrow lands on the buyer key). */
const KEYS_FILE = process.env.KEYS_FILE || resolve(HERE, 'demo-output', 'p2p-prod-keys.json');
function demoKeys(rail) {
  let all = {};
  try { all = JSON.parse(readFileSync(KEYS_FILE, 'utf-8')); } catch { /* first run */ }
  let row = all[rail];
  if (!row) {
    const seller = PQKey.createNewKey();
    const buyer = PQKey.createNewKey();
    row = {
      seller: seller.getPrivateKeySeedAsHex(),
      buyer: buyer.getPrivateKeySeedAsHex(),
      createdAt: new Date().toISOString(),
    };
    all[rail] = row;
    mkdirSync(dirname(KEYS_FILE), { recursive: true });
    writeFileSync(KEYS_FILE, JSON.stringify(all, null, 2));
  }
  return { seller: PQKey.fromPrivateKeyHex(row.seller), buyer: PQKey.fromPrivateKeyHex(row.buyer) };
}

async function capabilities() {
  const res = await fetch(`${ENGINE}/capabilities`);
  if (!res.ok) throw new Error(`capabilities ${res.status}`);
  return res.json();
}

/** The engine's escrow key must be the one the wallet trusts (p2pEscrow does this too). */
function escrowVault(sellerKey, buyerKey, enginePubHex) {
  return Escrow.twoOfThree({
    seller: sellerKey,
    buyer: buyerKey,
    engine: PQKey.fromPrefixedPublicKey(Utils.HEX.decode(enginePubHex)),
  });
}

// ── browser helpers ────────────────────────────────────────────────────────

async function openNav(page, label) {
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

/** Navigate to P2P and make sure the wallet is unlocked (the screen gates on it). */
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
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  throw new Error(`P2P screen did not mount: ${text.slice(0, 400)}`);
}

/** Cancel any ads this seller still has open from an interrupted earlier run
 *  (they all carry the same DID, so the book would otherwise show two ads). */
async function cancelOwnAds(page) {
  await el(page, 'p2p-tab-open').click();
  await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    const toggle = el(page, `p2p-order-${i}-toggle`);
    if (!(await toggle.count())) break;
    await toggle.click();
    await page.waitForTimeout(500);
    const cancel = el(page, `p2p-cancel-order-${i}`);
    if (await cancel.count()) {
      await cancel.click();
      await approve(page);
      await page.waitForTimeout(2500);
      await refresh(page);
      log(`  cancelled stale ad #${i}`);
      i = -1; // list re-renders after the cancel
      continue;
    }
    await toggle.click();
    await page.waitForTimeout(300);
  }
}
async function approve(page) {
  const sheet = page.locator('[data-testid="confirm-transaction"]');
    const ok = await sheet.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  if (!ok) return false;
  await page.locator('[data-testid="confirm-password"]').fill(PWD);
  await page.locator('[data-testid="confirm-ok"]').click();
  await page.waitForTimeout(800);
  return true;
}

async function createWalletFromKey(browser, key, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try { delete globalThis.showSaveFilePicker; } catch { /* ignore */ }
    // No platform authenticator in headless Chromium: report WebAuthn as
    // unavailable so confirmImportant falls straight to the password sheet
    // (otherwise credentials.create() waits for a user gesture we cannot give).
    try {
      Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    } catch { /* ignore */ }
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('console', (m) => { if (m.type() === 'error') log(`[browser:${name}]`, m.text()); });
  page.on('response', async (r) => {
    if (r.url().includes('/p2p/') && r.status() >= 400) {
      const body = await r.text().catch(() => '');
      if (ANCHOR_BUSY.test(body)) anchorBusyAt.set(page, Date.now());
      log(`[engine ${r.status()}] ${r.request().method()} ${r.url()} ${body.slice(0, 400)}`);
    }
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  await openNav(page, 'Keys');
  await page.getByText('Import Private Key').click();
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(key.getPrivateKeyHex());
  await page.getByText('Import Key').click();
  await page.getByText('Set Wallet Password').waitFor({ timeout: TIMEOUT });
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PWD);
  await page.getByPlaceholder('Confirm password').fill(PWD);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/p2p-prod-${name}-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
  // unlock
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const pwdInput = el(page, 'wallet-password-input').first();
  if (await pwdInput.isVisible().catch(() => false)) {
    await pwdInput.fill(PWD);
    await el(page, 'unlock-wallet-button').first().click();
    await page.waitForTimeout(2500);
  }
  log(`  wallet ${name}: ${Address.fromKey(MainNetParams.get(), key).toString()}`);
  return { context, page };
}

/** Viewport shot (1440x1000 @2x = the size the guide's PDFs embed). `selector`
 *  scrolls that element to the top of the view (with a little breathing room). */
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
  log(`  ✓ ${name}`);
}

async function refresh(page) {
  await el(page, 'p2p-refresh').click().catch(() => {});
  await page.waitForTimeout(1500);
}

async function status(page, id = 'p2p-swap-0-status') {
  return (await el(page, id).first().textContent().catch(() => null)) ?? '';
}

async function waitStatus(page, expected, ms = TIMEOUT, id = 'p2p-swap-0-status') {
  const list = Array.isArray(expected) ? expected : [expected];
  const t0 = Date.now();
  let lastTick = Date.now();
  for (;;) {
    const txt = await status(page, id);
    if (list.includes(txt)) return txt;
    if (Date.now() - t0 > ms) {
      const notice = await el(page, 'p2p-notice').first().textContent().catch(() => null);
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      throw new Error(`timeout: want ${list.join('|')}, got "${txt}" | notice: ${notice} | page: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    // Long waits (the engine's settlement hook): keep the view fresh.
    if (ms > 120_000 && Date.now() - lastTick > 12_000) {
      await refresh(page).catch(() => {});
      lastTick = Date.now();
    }
    await page.waitForTimeout(500);
  }
}

/** Click a party action and wait for the target state, retrying when the
 *  engine's L1-SOCIAL anchor has no spendable output yet (its change needs one
 *  ~20s block to confirm, and each swap event is anchored). */
async function actUntil(page, testid, expected, { tries = 10, wait = 45_000, ms = 90_000 } = {}) {
  const list = Array.isArray(expected) ? expected : [expected];
  let last;
  for (let i = 0; i < tries; i++) {
    await el(page, testid).click().catch(() => {});
    await approve(page);
    try {
      return await waitStatus(page, list, ms);
    } catch (e) {
      last = e;
      const busy = (anchorBusyAt.get(page) ?? 0) > Date.now() - 180_000;
      log(`  ${testid} not through yet${busy ? ' (anchor busy)' : ''} — retry ${i + 1}/${tries}`);
      await sleep(busy ? wait : 15_000);
      await refresh(page).catch(() => {});
    }
  }
  throw last;
}

/** Seller's collection profile (party-private) per rail. BIG's unit price in
 *  the rail's fiat: 71.5 CNY ≈ 9.9 USD → 10 BIG = 715 CNY / 99 USD. */
const RAIL_PROFILE = {
  wechat: { name: 'Zhang San', account: 'wxid_pay8888', price: '71.5', currency: 'CNY' },
  alipay: { name: 'Li Si', account: '13800138000', price: '71.6', currency: 'CNY' },
  bank: { name: 'Wang Wu', account: '6222 0202 0011 2233 4455', bank: 'ICBC', price: '9.9', currency: 'USD' },
};
/** The taker's own channel details (private; required by `p2p.channelRequired`). */
const BUYER_PROFILE = {
  wechat: { account: 'wxid_buyer01' },
  alipay: { account: '13900139000' },
  bank: { account: '6217 0000 1111 2222 333', bank: 'ICBC' },
};

async function captureRail(browser, rail, enginePubHex) {
  const profile = RAIL_PROFILE[rail] ?? RAIL_PROFILE.wechat;
  const tag = `p2p-cny-${rail}`;
  const shotN = (n, who, page, selector) => shot(page, `${tag}-${String(n).padStart(2, '0')}-${who}-en.png`, selector);

  const { seller: sellerKey, buyer: buyerKey } = demoKeys(rail);
  const buyerAddress = Address.fromKey(MainNetParams.get(), buyerKey).toString();
  const vault = escrowVault(sellerKey, buyerKey, enginePubHex);
  const escrowAddress = vault.address(MainNetParams.get()).toBase58();
  log(`\n━━━ ${rail} ━━━`);
  log(`  seller ${Address.fromKey(MainNetParams.get(), sellerKey).toString()}`);
  log(`  buyer  ${buyerAddress}`);
  log(`  vault  ${escrowAddress}`);
  await cleanupRail(sellerKey, buyerKey);

  let escrowTxHash = '';
  if (!DRY_RUN) {
    // 1. fund the seller from the prod validator keystore (skip when a re-run
    //    already funded this persisted key)
    let have = 0n;
    try { have = await waitBalance(sellerKey, FUND_UNITS, 6000); } catch { have = 0n; }
    if (have >= FUND_UNITS) {
      log(`  seller already funded (${have} BIG units)`);
    } else {
      log('  funding seller (12 BIG from the validator keystore)…');
      for (let attempt = 1; ; attempt++) {
        try {
          const f = fundSeller(sellerKey);
          log(`  funding tx ${f.txid}`);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          log(`  funding attempt ${attempt} failed (${String(e).slice(-80)}), retrying in 60s…`);
          await sleep(60_000);
        }
      }
      await waitBalance(sellerKey, FUND_UNITS);
    }
    log('  seller funded + confirmed');

    // 2. the seller locks the 2-of-3 vault (real P2SH output). Reuse an
    //    existing unspent lock when a previous run already funded this vault.
    const existing = await findVaultLock(escrowAddress, vault);
    if (existing) {
      escrowTxHash = existing;
      log(`  reusing confirmed escrow lock ${escrowTxHash} → ${escrowAddress}`);
    } else {
      const w = walletFor([sellerKey]);
      const tx = await w.payToScript(null, Coin.valueOf(BIG_UNITS), null, vault.outputScript);
      escrowTxHash = tx.getHash().toString();
      log(`  escrow lock ${escrowTxHash} → ${escrowAddress}`);
      await waitTxConfirmed(escrowTxHash);
      log('  escrow lock CONFIRMED');
    }
  }

  // 3. two browser wallets (the imported keys the script controls)
  const seller = await createWalletFromKey(browser, sellerKey, `${rail}-seller`);
  const buyer = await createWalletFromKey(browser, buyerKey, `${rail}-buyer`);
  const s = seller.page;
  const b = buyer.page;

  // 4. seller saves the CNY collection profile
  await gotoP2P(s);
  await cancelOwnAds(s);
  await el(s, 'p2p-tab-mine').click();
  await s.waitForTimeout(1200);
  await el(s, `p2p-profile-method-${rail}`).click();
  await el(s, 'p2p-profile-name').fill(profile.name);
  await el(s, 'p2p-profile-account').fill(profile.account);
  if (profile.bank) await el(s, 'p2p-profile-bank').fill(profile.bank);
  await el(s, 'p2p-profile-save').click();
  await approve(s);
  await s.waitForTimeout(2000);
  await shotN(1, 'profile', s, '[data-testid="p2p-profile-card"]');

  // 5. seller lists 10 BIG for 715 CNY on the rail (the form is in My swaps)
  await el(s, 'p2p-give-token').fill('bc');
  await s.waitForTimeout(1000);
  await el(s, 'p2p-give-amount').fill('10');
  await el(s, 'p2p-want-amount').fill(profile.price);
  // Payment methods are multi-select and the first rail is the order's
  // `wantRail`: select the wanted rail, then drop the default `wechat`.
  await el(s, `p2p-rail-${rail}`).click();
  await s.waitForTimeout(300);
  if (rail !== 'wechat') {
    await el(s, 'p2p-rail-wechat').click();
    await s.waitForTimeout(300);
  }
  await el(s, 'p2p-want-currency').fill(profile.currency);
  await s.waitForTimeout(400);
  await shotN(2, 'order', s, '[data-testid="p2p-order-side"]');
  await el(s, 'p2p-create').click();
  const approvedListing = await approve(s);
  await s.waitForTimeout(3500);
  const listingNotice = await el(s, 'p2p-notice').first().textContent().catch(() => null);
  log(`  listing: approved=${approvedListing} notice=${listingNotice}`);
  if (!listingNotice) {
    const txt = await s.evaluate(() => document.body.innerText).catch(() => '');
    log(`  seller page: ${txt.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (DRY_RUN) {
    log('  DRY_RUN: stopping after the listing form');
    await seller.context.close();
    await buyer.context.close();
    return { rail, dryRun: true };
  }

  // 6. buyer opens the ad and matches (receive address = their own key).
  //    The taker must also carry channel details for the rail
  //    (`p2p.channelRequired`) — saved privately, never in the book.
  await gotoP2P(b);
  await el(b, 'p2p-tab-mine').click();
  await b.waitForTimeout(1200);
  await el(b, `p2p-profile-method-${rail}`).click();
  await el(b, 'p2p-profile-name').fill('Demo Buyer');
  await el(b, 'p2p-profile-account').fill(BUYER_PROFILE[rail].account);
  if (BUYER_PROFILE[rail].bank) await el(b, 'p2p-profile-bank').fill(BUYER_PROFILE[rail].bank);
  await el(b, 'p2p-profile-save').click();
  await approve(b);
  await b.waitForTimeout(1500);
  await el(b, 'p2p-tab-open').click();
  await b.waitForTimeout(1000);
  await el(b, 'p2p-order-0-toggle').waitFor({ timeout: TIMEOUT });
  await el(b, 'p2p-order-0-toggle').click();
  await b.waitForTimeout(600);
  await el(b, 'p2p-buy-recv').fill(buyerAddress);
  await b.waitForTimeout(400);
  await shotN(3, 'match', b, '[data-testid="p2p-order-0"]');
  await actUntil(b, 'p2p-buy-confirm', 'MATCHED');
  await shotN(4, 'matched', b, '[data-testid="p2p-swap-0"]');

  // 7. seller locks with the real funding tx hash (engine proves it on L0)
  await sleep(5000);
  await el(s, 'p2p-tab-mine').click();
  await s.waitForTimeout(800);
  await refresh(s);
  await waitStatus(s, 'MATCHED');
  await el(s, 'p2p-swap-0-txhash').fill(escrowTxHash);
  await shotN(5, 'escrow-lock', s, '[data-testid="p2p-swap-0"]');
  await actUntil(s, 'p2p-swap-0-lock', ['ESCROW_LOCKED', 'PAYMENT_PENDING'], { ms: 180_000 });
  await shotN(6, 'escrow-locked', s, '[data-testid="p2p-swap-0"]');
  // the lock arms the settlement hook: the wallet presigns the release/refund
  // skeletons right after ESCROW_LOCKED. If that call lost the anchor race,
  // the card offers a Presign button — click it until the swap reports armed.
  let presigned = false;
  for (let i = 0; i < 12; i++) {
    if (await el(s, 'p2p-swap-0-presigned').count()) { presigned = true; break; }
    const btn = el(s, 'p2p-swap-0-presign');
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await approve(s);
    }
    await sleep(5000);
    await refresh(s);
  }
  log(`  presigned=${presigned}`);

  // 8. buyer pulls the payment instructions
  await el(b, 'p2p-tab-mine').click();
  await b.waitForTimeout(800);
  await refresh(b);
  await waitStatus(b, 'ESCROW_LOCKED');
  await shotN(7, 'buy-locked', b, '[data-testid="p2p-swap-0"]');
  await el(b, 'p2p-swap-0-instructions').click();
  await approve(b);
  await el(b, 'p2p-swap-0-instructions-panel').waitFor({ timeout: TIMEOUT }).catch(async () => {
    await sleep(45_000);
    await el(b, 'p2p-swap-0-instructions').click();
    await approve(b);
    await el(b, 'p2p-swap-0-instructions-panel').waitFor({ timeout: TIMEOUT });
  });
  await b.waitForTimeout(800);
  await shotN(8, 'instructions', b, '[data-testid="p2p-swap-0"]');
  const panel = await el(b, 'p2p-swap-0-instructions-panel').textContent();
  const remark = (panel.match(/Remark:\s*([0-9a-f]+)/) ?? [])[1] ?? '';

  // 9. buyer pays (fiat leg is simulated) and claims with the 流水号
  const txId = rail === 'alipay'
    ? '20' + randomBytes(14).toString('hex').slice(0, 26).toUpperCase()
    : rail === 'bank'
      ? '3029' + randomBytes(6).toString('hex').slice(0, 12).toUpperCase()
      : '4203' + randomBytes(8).toString('hex').slice(0, 12).toUpperCase();
  await el(b, 'p2p-swap-0-txid').fill(txId);
  await b.waitForTimeout(400);
  await shotN(9, 'payment-pending', b, '[data-testid="p2p-swap-0"]');
  await actUntil(b, 'p2p-swap-0-proof', 'PAYMENT_CLAIMED');
  await shotN(10, 'payment-claimed', b, '[data-testid="p2p-swap-0"]');

  // 10. seller checks their own statement and confirms
  await refresh(s);
  await waitStatus(s, 'PAYMENT_CLAIMED');
  await shotN(11, 'seller-confirm', s, '[data-testid="p2p-swap-0"]');
  const verified = await actUntil(s, 'p2p-swap-0-confirm', ['PAYMENT_VERIFIED', 'ESCROW_RELEASED', 'COMPLETED'], { ms: 180_000 });
  log(`  seller confirm → ${verified}`);
  if (verified === 'PAYMENT_VERIFIED') await shotN(12, 'payment-verified', s, '[data-testid="p2p-swap-0"]');

  // 11. the settlement hook releases the escrow to the buyer's address — a
  //     real L0 spend the engine co-signs; it waits for CONFIRMED, so give it
  //     time (the anchor of the follow-up event can also queue behind the
  //     L1-SOCIAL block, which is why the state may rest at ESCROW_RELEASED).
  const released = await waitStatus(s, ['ESCROW_RELEASED', 'COMPLETED'], 900_000);
  log(`  release → ${released} (confirmed on L0)`);
  await shotN(13, 'escrow-released', s, '[data-testid="p2p-swap-0"]');

  // 12. the buyer holds the released BIG: their own wallet balance.
  await el(b, 'p2p-tab-mine').click();
  await b.waitForTimeout(800);
  await refresh(b);
  await b.waitForTimeout(2000);
  await openNav(b, 'Balance');
  await b.waitForTimeout(2500);
  const balRefresh = b.getByText('Apply / Refresh').first();
  if (await balRefresh.isVisible().catch(() => false)) await balRefresh.click().catch(() => {});
  await b.waitForTimeout(3500);
  await shotN(14, 'completed', b);

  const summary = {
    rail,
    currency: profile.currency,
    price: profile.price,
    escrowAddress,
    escrowTxHash,
    remark,
    txId,
    sellerAddress: Address.fromKey(MainNetParams.get(), sellerKey).toString(),
    buyerAddress,
    statuses: { matched: 'MATCHED', verified, released },
    capturedAt: new Date().toISOString(),
  };
  await seller.context.close();
  await buyer.context.close();
  return summary;
}

async function main() {
  if (!DRY_RUN && !ALLOW_REAL_FUNDS) {
    throw new Error(
      'refusing to spend real funds: this script funds a production wallet and locks a real BIG escrow.\n' +
      '  Demo/PDF captures use the no-funds harness instead:  ./p2pdemo.sh capture walkthrough\n' +
      '  (e2e/capture-p2p-cny.mjs: memory engine, synthetic tx hashes, no money moves).\n' +
      '  An operator who really wants a production-escrow capture sets ALLOW_REAL_FUNDS=1.',
    );
  }
  const caps = await capabilities();
  log(`engine ${ENGINE}: rails=${caps.rails?.join(',')} escrow=${caps.escrow} chain=${JSON.stringify(caps.chain)}`);
  if (!caps.escrowPubkey) throw new Error('engine has no escrowPubkey');
  const browser = await chromium.launch({ headless: true });
  const runs = {};
  try {
    for (const rail of RAILS) runs[rail] = await captureRail(browser, rail, caps.escrowPubkey);
  } finally {
    await browser.close();
  }
  if (!DRY_RUN) {
    writeFileSync(
      resolve(HERE, 'demo-output', 'p2p-prod-capture.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), app: APP, engine: ENGINE, rails: RAILS, runs }, null, 2),
    );
  }
  log('\nDone.');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
