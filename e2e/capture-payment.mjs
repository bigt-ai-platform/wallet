#!/usr/bin/env node
/**
 * Capture payment-flow screenshots and generate payment-flow.pdf.
 *
 * Creates the wallet in the app via an imported Node-generated key (funded on
 * the L0 payment base), unlocks it, and sends a real BIG payment. The PDF shows
 * the full payment lifecycle:
 *   - how the user sends a payment (send form)
 *   - transaction status check (Payment Tracking tab, CONFIRMED)
 *   - payment history (History tab)
 *   - assets displayed in the recipient's (Bob's) account
 *
 * Usage: APP_URL=... E2E_SERVER_URL=... E2E_L1_URL=... node capture-payment.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.APP_URL || 'http://localhost:18081/').replace(/\/+$/, '') + '/';
const SVR = (process.env.E2E_SERVER_URL || 'http://localhost:18088/').replace(/\/+$/, '') + '/';
const L1 = (process.env.E2E_L1_URL || 'http://localhost:18086/').replace(/\/+$/, '') + '/';
const SHOTS = resolve(HERE, 'demo-output/screenshots');
const PDFS = resolve(HERE, 'demo-output/pdfs');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(PDFS, { recursive: true });

const PWD = 'AlicePass123!';

/** Point the app at L0/L1 by writing settings storage directly (the server-URL
 *  input and the L1-chain URL inputs share a placeholder, so the Settings UI is
 *  unreliable for automation). */
async function configureAppUrls(page, serverUrl, l1Url) {
  await page.evaluate(([sUrl, chains]) => {
    localStorage.setItem('mmkv.default\\settings.serverUrl', sUrl);
    localStorage.setItem('mmkv.default\\settings.l1Chains', chains);
  }, [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])]);
}

/** Import a private key into the app wallet and save it with a password. */
async function importKeyIntoWallet(page, privHex) {
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.locator('[data-testid="wallet-screen"]').getByText('Manage Wallet').click();
  await page.waitForURL('**/wallet/keys**');
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PWD);
  await page.getByPlaceholder('Confirm password').fill(PWD);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.getByText('Save Wallet').click(),
  ]);
  if (dl) await dl.saveAs('/tmp/wallet-demo-e2e.json');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

/** Reload the app (wallet stays locked) and unlock it via the Transaction screen. */
async function unlockWallet(page) {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: 'Transaction', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('Enter wallet password').fill(PWD);
  await page.getByText('Unlock Wallet').click();
  await page.waitForTimeout(3000);
}

/**
 * Wait until the Wallet tab shows a positive balance for a token. The asset
 * card renders tokenname + a numeric balance; rather than assume the exact DOM
 * layout we poll the whole screen for the token name AND a positive decimal
 * balance (so the screenshot cannot show an empty "No Assets" state).
 */
async function waitForAssetBalance(page, tokenName, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate((name) => {
      const text = document.body.innerText || '';
      if (!text.includes(name)) return false;
      const m = text.match(/(\d+\.?\d*)/g);
      return !!m && m.some((n) => parseFloat(n) > 0);
    }, tokenName);
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for positive ${tokenName} balance in Wallet assets`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Wait until a status badge text appears (e.g. 'CONFIRMED' in History, 'confirmed' in Payments). */
async function waitForText(page, text, timeoutMs = 30000) {
  await page.waitForFunction(
    (t) => (document.body.innerText || '').includes(t),
    text,
    { timeout: timeoutMs },
  ).catch(() => {
    throw new Error(`Timed out waiting for text: ${text}`);
  });
}

async function main() {
  const sdk = await import('../packages/bigtangle-ts/dist/index.js');
  const { PQKey, Address, TestParams, Wallet } = sdk;

  // 1. Generate the wallet key in Node and fund it on the L0 payment base
  //    (the network spends classic base58 addresses; the app shows the PQ hex).
  const aliceKey = PQKey.createNew();
  const aliceAddress = Address.fromKey(TestParams.get(), aliceKey).toString();
  // The recipient (Bob): the status check below keys by the transaction's first
  // output, i.e. this address; we later import his key to show his assets.
  const bobKey = PQKey.createNew();
  const BOB = Address.fromKey(TestParams.get(), bobKey).toString();
  const fundRes = await fetch(SVR + 'fundAddresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: [{ address: aliceAddress, value: 10000000000 }] }),
  });
  const fundBody = await fundRes.json();
  if (fundBody.errorcode !== 0) throw new Error('Funding failed: ' + JSON.stringify(fundBody));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { delete globalThis.showSaveFilePicker; } catch {} });

  // Screenshot 1: Transaction screen locked (no wallet yet)
  await page.goto(APP, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/01-transaction-locked.png` });
  console.log('ok 01-transaction-locked');

  // Import Alice's key into the app wallet
  await importKeyIntoWallet(page, aliceKey.getPrivateKeyHex());
  await configureAppUrls(page, SVR, L1);
  await unlockWallet(page);

  // 2. Wait for the funding coinbase to be CONFIRMED on L0 before sending —
  //    spending an unconfirmed coinbase can leave the payment stuck at BATCHED.
  const aliceWallet = Wallet.fromKeysURL(TestParams.get(), [aliceKey], SVR);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const cands = await aliceWallet.calculateAllSpendCandidates(null, false);
    if (cands.some(
      (c) => c.getUTXO()?.getTokenId() === 'bc' && c.getUTXO()?.isConfirmed(),
    )) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error('Funding did not confirm for demo wallet');
  await page.waitForTimeout(3000);

  // Screenshot 2: Transaction screen unlocked with BIG token selected
  await page.screenshot({ path: `${SHOTS}/02-transaction-unlocked.png` });
  console.log('ok 02-transaction-unlocked');

  // Screenshot 3: Wallet screen with BIG balance (sender's assets) — wait for
  //               the funded BIG balance to render so the shot is not empty.
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await waitForAssetBalance(page, 'BIG');
  await page.screenshot({ path: `${SHOTS}/03-wallet-balance.png` });
  console.log('ok 03-wallet-balance');

  // Screenshot 4: send form with recipient filled (amount added next so the
  //               screenshot clearly shows "how the user sends a payment")
  await page.getByRole('tab', { name: 'Transaction', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByPlaceholder('Recipient').fill(BOB);
  await page.screenshot({ path: `${SHOTS}/04-send-form-filled.png` });
  console.log('ok 04-send-form-filled');

  // 3. Fill the amount and send the payment for real (window.confirm on web).
  //    Wait for the L0 submitTransaction request so we know the send happened.
  await page.getByPlaceholder('0.00').first().fill('0.001');
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const submitted = page
    .waitForRequest(
      (req) => req.url().includes(SVR) && req.url().includes('submitTransaction'),
      { timeout: 30000 }
    )
    .catch(() => null);
  await page.locator('text=Send Payment').last().click();
  if (!(await submitted)) throw new Error('Send Payment did not submit a transaction');

  // 4. Wait-check the transaction status until the payment is CONFIRMED on L0.
  let confirmedTxHash = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(SVR + 'getTransactionsStatusByAddress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: BOB }),
    });
    const data = await res.json();
    const hit = (data.transactions || []).find((t) => t.status === 'CONFIRMED');
    if (hit) {
      confirmedTxHash = hit.txHash;
      break;
    }
  }
  if (!confirmedTxHash) throw new Error('Payment did not confirm for PDF screenshot');

  // Screenshot 5: transaction history. loadHistory only runs on unlock + after
  // the send (before the tx confirms), so the list is stale — reload the app so
  // it re-runs against the confirmed chain, then open the History tab and wait
  // for the payment's txHash entry to render.
  await unlockWallet(page);
  await page.locator('text=History').first().click();
  await waitForText(page, confirmedTxHash.slice(0, 20));
  await page.screenshot({ path: `${SHOTS}/05-transaction-history.png` });
  console.log('ok 05-transaction-history');

  // Screenshot 6: payment tracking tab showing the confirmed status (the
  //               on-chain transaction status check). Refresh pulls the live
  //               status from the L0 getTransactionStatus endpoint; the badge
  //               is styled textTransform:uppercase so it renders 'CONFIRMED'.
  await page.getByText('Payments', { exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByText('Refresh').first().click();
  await waitForText(page, 'CONFIRMED');
  await page.screenshot({ path: `${SHOTS}/06-payment-tracking.png` });
  console.log('ok 06-payment-tracking');

  await ctx.close();

  // 5. Screenshot 7: Bob's account — import Bob's key in a FRESH context (fresh
  //    local storage = separate account) and show his assets on the Wallet tab.
  const bobCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const bobPage = await bobCtx.newPage();
  await bobPage.addInitScript(() => { try { delete globalThis.showSaveFilePicker; } catch {} });
  await bobPage.goto(APP, { waitUntil: 'networkidle', timeout: 15000 });
  await bobPage.waitForTimeout(1500);
  await importKeyIntoWallet(bobPage, bobKey.getPrivateKeyHex());
  await configureAppUrls(bobPage, SVR, L1);
  await unlockWallet(bobPage);

  // Bob received the BIG payment from Alice — wait for his asset list to show
  // a positive BIG balance so the shot proves the funds arrived.
  await bobPage.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await waitForAssetBalance(bobPage, 'BIG');
  await bobPage.screenshot({ path: `${SHOTS}/07-bob-wallet-assets.png` });
  console.log('ok 07-bob-wallet-assets');

  await bobCtx.close();
  await browser.close();

  // 6. Generate payment-flow.pdf
  const SCREENS = [
    ['01-transaction-locked', 'Transaction (Locked)'],
    ['02-transaction-unlocked', 'Transaction (Unlocked)'],
    ['03-wallet-balance', 'Sender Assets (Alice)'],
    ['04-send-form-filled', 'Send Payment Form (filled)'],
    ['05-transaction-history', 'Transaction History'],
    ['06-payment-tracking', 'Payment Tracking (CONFIRMED status)'],
    ['07-bob-wallet-assets', 'Recipient Assets (Bob)'],
  ];
  const rows = SCREENS
    .map(([name, label]) => {
      const fp = `${SHOTS}/${name}.png`;
      if (!existsSync(fp)) return '';
      const b64 = readFileSync(fp).toString('base64');
      return `<div class="screen"><h2>${label}</h2><img src="data:image/png;base64,${b64}" /></div>`;
    })
    .filter(Boolean)
    .join('\n');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bapp Payment Flow</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}h1{text-align:center}.screen{background:white;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);break-inside:avoid}.screen img{width:100%;max-width:390px;display:block;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px}</style></head><body><h1>Bapp Wallet - Payment Flow</h1>${rows}</body></html>`;
  writeFileSync(`${PDFS}/payment-flow.html`, html);
  const pdfBrowser = await chromium.launch();
  const pdfPage = await pdfBrowser.newPage();
  await pdfPage.setContent(html, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: `${PDFS}/payment-flow.pdf`, format: 'A4', printBackground: true });
  await pdfBrowser.close();
  console.log('ok payment-flow.pdf');
}

main().catch((e) => { console.error(e); process.exit(1); });
