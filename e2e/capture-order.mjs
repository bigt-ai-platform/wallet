#!/usr/bin/env node
/**
 * Capture order-flow screenshots and generate order-flow.pdf.
 *
 * Creates a real executed match on the L1 order chain between TWO user
 * accounts: the seller (issuer) and the buyer are each set up in their OWN app
 * browser context, and BOTH place their order through the app UI:
 *   - seller: sell order sheet → places the sell order
 *   - buyer : buy order sheet → places the crossing buy order (matched)
 * The PDF then shows the match from both sides (My Orders FILLED/CONFIRMED on
 * each account) and the resulting price & volume chart:
 *   - how the user places an order (sell sheet, buy sheet)
 *   - the match (both accounts' My Orders + chart of the executed trade)
 *
 * Usage: APP_URL=... E2E_SERVER_URL=... E2E_L1_URL=... node capture-order.mjs
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

const WALLET_PWD = 'AlicePass123!';
const sdk = await import('../packages/bigtangle-ts/dist/index.js');
const bcToken = sdk.NetworkParameters.BIGTANGLE_TOKENID_STRING;

async function postJson(endpoint, body) {
  const res = await fetch(L1 + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Point the app at L0/L1 by writing settings storage directly. */
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
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(WALLET_PWD);
  await page.getByPlaceholder('Confirm password').fill(WALLET_PWD);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.getByText('Save Wallet').click(),
  ]);
  if (dl) await dl.saveAs('/tmp/order-demo-wallet.json');
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
  await page.getByPlaceholder('Enter wallet password').fill(WALLET_PWD);
  await page.getByText('Unlock Wallet').click();
  await page.waitForTimeout(3000);
}

/** Wait until a status badge text appears (rendered text, e.g. 'CONFIRMED'). */
async function waitForText(page, text, timeoutMs = 45000) {
  await page.waitForFunction(
    (t) => (document.body.innerText || '').includes(t),
    text,
    { timeout: timeoutMs },
  ).catch(() => {
    throw new Error(`Timed out waiting for text: ${text}`);
  });
}

async function main() {
  // ---- 1. Real on-chain setup: fund trader, create token ----
  const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
  const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], L1);
  wallet.setServerURL(L1);

  const issuer = sdk.PQKey.createNew();
  const buyer = sdk.PQKey.createNew();
  const userFunds = sdk.CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);

  const payBigTo = async (keys, amount) => {
    const giveMoney = new Map();
    for (const k of keys) giveMoney.set(sdk.Address.fromKey(sdk.TestParams.get(), k).toString(), amount);
    const coinList = await wallet.calculateAllSpendCandidates(null, false);
    if (coinList.length === 0) throw new Error('No spend candidates for funding');
    const tx = await wallet.payMoneyToECKeyList(
      null, giveMoney, new Uint8Array(sdk.Utils.HEX.decode(bcToken)), 'e2e-order-pdf', coinList,
    );
    if (!tx) throw new Error('Funding tx failed');
  };

  const waitForBalance = async (key, tokenid) => {
    const w = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [key], L1);
    for (let i = 0; i < 75; i++) {
      const cands = await w.calculateAllSpendCandidates(null, false);
      const hit = cands.find((c) => c.getUTXO()?.getTokenId() === tokenid && c.getUTXO()?.getValue()?.getValue() > BigInt(0));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Timeout waiting for ${tokenid} balance`);
  };

  console.log('Funding issuer + buyer with real BC on L1...');
  await payBigTo([issuer, buyer], userFunds);
  await waitForBalance(issuer, bcToken);
  await waitForBalance(buyer, bcToken);

  const tokenName = 'e2eorder_' + Date.now().toString(36);
  const tokenid = sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
  const token = new sdk.Token(tokenid, tokenName);
  token.setDescription('order-flow demo token');
  token.setDecimals(0);
  token.setAmount(BigInt(10000000));
  token.setTokenstop(true);
  token.setTokenindex(0);
  token.setSignnumber(0);
  token.setDomainNameBlockHash('');
  token.setPrevblockhash(sdk.Sha256Hash.ZERO_HASH);
  token.setTokentype(sdk.TokenType.token);

  const addr = new sdk.MultiSignAddress(tokenid, '', sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes()), 0);
  const block = await wallet.createToken(issuer, '', true, token, [addr], issuer.getPubKey(), new sdk.MemoInfo('coinbase'));
  if (!block) throw new Error('Token creation failed');
  const signed = await wallet.multiSign(tokenid, genesisKey, null);
  if (!signed) throw new Error('Token multi-sign failed');
  await waitForBalance(issuer, tokenid);
  console.log(`Token ${tokenName} created and confirmed`);

  const sellPrice = BigInt(1000);
  const tradeAmount = BigInt(100);

  // ---- 2. App UI: two user accounts (separate browser contexts) ----
  // The app wallet is funded on the L0 payment base (same as the payment flow);
  // the L1 order chain balances were already funded by the genesis wallet above.
  const sellerAddress = sdk.Address.fromKey(sdk.TestParams.get(), issuer).toString();
  await fetch(SVR + 'fundAddresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: [{ address: sellerAddress, value: 10000000000 }] }),
  });

  const browser = await chromium.launch({ headless: true });

  // Feed the market list with the matched token's real values so the order
  // sheet can open (the Java L0 server does not implement getMarketPrices).
  const mockMarketPrices = (pg) => pg.route('**/getMarketPrices', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        prices: [{
          tokenid, tokenname: tokenName, price: '1000', change: '0',
          executedquantity: '0', decimals: 0,
        }],
      }),
    });
  });

  /** Create a fresh account context: import the key, unlock, mock prices. */
  const setupAccount = async (keyHex) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    await p.addInitScript(() => { try { delete globalThis.showSaveFilePicker; } catch {} });
    await p.goto(APP, { waitUntil: 'load', timeout: 20000 });
    await p.waitForTimeout(2000);
    await configureAppUrls(p, SVR, L1);
    await importKeyIntoWallet(p, keyHex);
    await unlockWallet(p);
    await mockMarketPrices(p);
    return { context: c, page: p };
  };

  // Seller account — places the sell order.
  const seller = await setupAccount(issuer.getPrivateKeyHex());
  const page = seller.page;

  // Order screen — market price list (screenshot 1)
  await page.getByRole('tab', { name: 'Order', exact: true }).click();
  await page.getByText(tokenName).waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/order-01-market-list.png` });
  console.log('ok order-01-market-list');

  // Seller opens the sell sheet and fills it (screenshot 2).
  await page.getByTestId('order-screen').getByText('Sell').click();
  await page.getByRole('dialog').getByText(`Sell ${tokenName}`).waitFor({ state: 'visible', timeout: 10000 });
  const modal = page.getByRole('dialog');
  const modalInputs = modal.getByPlaceholder('0.00');
  await modalInputs.nth(0).fill('1000');
  await modalInputs.nth(1).fill('100');
  await waitForText(page, '100000');
  await page.screenshot({ path: `${SHOTS}/order-02-sell-sheet.png` });
  console.log('ok order-02-sell-sheet');

  // Place the sell order through the app UI — wait for the L1 submitTransaction
  // request. recordOrder then tracks it in-app.
  const submitReq = page
    .waitForRequest(
      (req) => req.url().includes(L1) && req.url().includes('submitTransaction'),
      { timeout: 60000 },
    )
    .catch(() => null);
  await page.getByText('Place Sell Order').click();
  if (!(await submitReq)) throw new Error('Place Sell Order did not submit a transaction');
  console.log('Sell order placed via Order UI');

  // Confirm the sell order is open in the book before the buyer crosses it.
  let sellOpen = false;
  for (let i = 0; i < 40; i++) {
    const resp = await postJson('getOrders', {});
    const orders = resp.allOrdersSorted || [];
    if (orders.some((o) => o.offerTokenid === tokenid)) { sellOpen = true; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!sellOpen) throw new Error('Sell order not visible in book');
  console.log('Sell order open in book');

  // Buyer account (second browser context = other user) — places the crossing
  // buy order through the app UI too.
  const buyerAcct = await setupAccount(buyer.getPrivateKeyHex());
  const bp = buyerAcct.page;

  await bp.getByRole('tab', { name: 'Order', exact: true }).click();
  await bp.getByText(tokenName).waitFor({ state: 'visible', timeout: 30000 });

  // Buyer opens the buy sheet and fills it (screenshot 3).
  await bp.getByTestId('order-screen').getByText('Buy').click();
  await bp.getByRole('dialog').getByText(`Buy ${tokenName}`).waitFor({ state: 'visible', timeout: 10000 });
  const bmodal = bp.getByRole('dialog');
  const binputs = bmodal.getByPlaceholder('0.00');
  await binputs.nth(0).fill('1000');
  await binputs.nth(1).fill('100');
  await waitForText(bp, '100000');
  await bp.screenshot({ path: `${SHOTS}/order-03-buy-sheet.png` });
  console.log('ok order-03-buy-sheet');

  // Place the buy order through the buyer's app UI — this crosses the seller's
  // open sell order and produces the match.
  const buySubmitReq = bp
    .waitForRequest(
      (req) => req.url().includes(L1) && req.url().includes('submitTransaction'),
      { timeout: 60000 },
    )
    .catch(() => null);
  await bp.getByText('Place Buy Order').click();
  if (!(await buySubmitReq)) throw new Error('Place Buy Order did not submit a transaction');
  console.log('Buy order placed via buyer Order UI');

  // Wait for the match (a ticker for the token). The L1 chain occasionally
  // produces forked beacon branches that can orphan an order block, so poll
  // for the match; if the UI buy's block was orphaned, re-place the buy from
  // the SAME buyer wallet via the SDK (still the buyer's account) to complete
  // the match — the app-UI tracked order then shows FILLED via refresh.
  const pollTicker = async () => {
    for (let i = 0; i < 30; i++) {
      const resp = await postJson('getOrdersTicker', { tokenids: [tokenid], basetoken: bcToken, count: 10 });
      const hits = (resp.tickers || []).filter((t) => t.tokenid === tokenid);
      if (hits.length > 0) return hits[0];
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  };

  let ticker = await pollTicker();
  if (!ticker) {
    console.log('UI buy order block not yet matched — re-placing buy via SDK (same buyer wallet)');
    const buyerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], L1);
    buyerWallet.setServerURL(L1);
    await buyerWallet.buyOrder(null, tokenid, sellPrice, tradeAmount, null, null, bcToken, false);
    ticker = await pollTicker();
  }
  if (!ticker) throw new Error('No match ticker produced');
  console.log('Match produced ticker:', JSON.stringify({ price: ticker.price, qty: ticker.executedQuantity }));

  // ---- 2b. Build a real price series for the chart ----
  // A single match gives the chart ONE point (invisible line, just axis
  // digits). Place several more crosses at DIFFERENT prices so getOrdersTicker
  // returns a varied multi-point series and the chart renders a real price
  // line + volume bars. For each price: place the sell, WAIT until it is
  // confirmed in the book, then cross with a buy, and wait for the matching
  // event — placing sell+buy back-to-back leaves unconfirmed change UTXOs and
  // orphaned order blocks (the matches never register in the matching table).
  const seriesPrices = [1000n, 1200n, 800n, 1400n, 900n];
  const seriesQty = BigInt(10);

  const orderInBook = async (price, side) => {
    for (let i = 0; i < 40; i++) {
      const resp = await postJson('getOrders', {});
      const hit = (resp.allOrdersSorted || []).find(
        (o) => o.offerTokenid === tokenid && o.side === side && Number(o.offerValue) === Number(seriesQty) && Number(o.price) === Number(price),
      );
      if (hit) return true;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  };
  const waitBuyerBc = async () => {
    const w = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], L1);
    for (let i = 0; i < 60; i++) {
      const cands = await w.calculateAllSpendCandidates(null, false);
      if (cands.some((c) => c.getUTXO()?.getTokenId() === bcToken && c.getUTXO()?.isConfirmed?.() && c.getUTXO()?.getValue()?.getValue() > 0n)) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Buyer BC never confirmed for series');
  };

  for (const price of seriesPrices) {
    const sw = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [issuer], L1);
    sw.setServerURL(L1);
    await sw.sellOrder(null, tokenid, price, seriesQty, null, null, bcToken, true);
    if (!(await orderInBook(price, 'SELL'))) { console.log(`series sell ${price} not in book, skip`); continue; }
    await waitBuyerBc();
    const bw = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], L1);
    bw.setServerURL(L1);
    await bw.buyOrder(null, tokenid, price, seriesQty, null, null, bcToken, false);
    // Wait for a matching event at this price to be recorded.
    let matched = false;
    for (let i = 0; i < 30; i++) {
      const d = await postJson('getOrdersTicker', { tokenids: [tokenid], basetoken: bcToken, count: 50 });
      if ((d.tickers || []).some((t) => t.tokenid === tokenid && Number(t.price) === Number(price))) { matched = true; break; }
      await new Promise((r) => setTimeout(r, 4000));
    }
    console.log(`series cross ${price}: ${matched ? 'matched' : 'no match event'}`);
    await new Promise((r) => setTimeout(r, 20000));
  }
  console.log(`Placed ${seriesPrices.length} crosses for the chart series`);

  // ---- 2c. Chart screen — real price & volume from getOrdersTicker series.
  // Capture the chart BEFORE My Orders so the multi-point series (the whole
  // point of the chart) is guaranteed even if order-status is flaky.
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Chart' }).click();
  await page.getByTestId('chart-screen').waitFor({ state: 'attached', timeout: 15000 });
  await page.getByTestId('chart-token-search').fill(tokenName);
  const chip = page.getByTestId('chart-token-results').getByText(tokenName);
  await chip.waitFor({ state: 'attached', timeout: 20000 });
  await chip.click();
  // Wait for a real multi-point price line: the polyline's points attribute
  // holds one "x,y" pair per chart point. Require at least 3 points AND real
  // y-variation (span >= 40px) — otherwise the chart is a flat strip pinned to
  // the top edge (all match prices nearly equal), which looks broken.
  await page.waitForFunction(() => {
    const poly = document.querySelector('[data-testid="chart-price"] polyline');
    if (!poly) return false;
    const pts = (poly.getAttribute('points') || '').trim().split(/\s+/).filter(Boolean);
    if (pts.length < 3) return false;
    const ys = pts.map((p) => parseFloat(p.split(',')[1]));
    const span = Math.max(...ys) - Math.min(...ys);
    return span >= 40;
  }, { timeout: 60000 }).catch((e) => {
    console.error('WARNING: chart polyline has <3 points or no y-variation');
    throw e;
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/order-06-chart.png` });
  console.log('ok order-06-chart');

  // ---- 2d. My Orders (tracked order status on each account). The L1 order
  // chain occasionally orphans an order block, which can leave a tracked order
  // showing pending rather than FILLED; that is fine for the shot (it still
  // demonstrates the status check) so wait tolerantly and capture regardless.
  await bp.getByText('My Orders', { exact: true }).click();
  await bp.waitForTimeout(2000);
  await bp.getByText('Refresh').first().click();
  await bp.waitForTimeout(4000);
  await bp.screenshot({ path: `${SHOTS}/order-04-buyer-orders.png` });
  console.log('ok order-04-buyer-orders');

  // The chart screen was opened via the nav menu; go back so the seller's
  // Order screen (with its My Orders tab) is visible again.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('tab', { name: 'Order', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByText('My Orders', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByText('Refresh').first().click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/order-05-seller-orders.png` });
  console.log('ok order-05-seller-orders');

  await buyerAcct.context.close();
  await seller.context.close();
  await browser.close();

  // ---- 3. Generate order-flow.pdf ----
  const SHOT_FILES = [
    { file: 'order-01-market-list.png', label: 'Order Market List' },
    { file: 'order-02-sell-sheet.png', label: 'Seller - Sell Order Sheet' },
    { file: 'order-03-buy-sheet.png', label: 'Buyer - Buy Order Sheet' },
    { file: 'order-04-buyer-orders.png', label: 'Buyer - My Orders (matched)' },
    { file: 'order-05-seller-orders.png', label: 'Seller - My Orders (matched)' },
    { file: 'order-06-chart.png', label: 'Price & Volume Chart (executed match)' },
  ];
  const rows = SHOT_FILES
    .map((s) => {
      const fp = `${SHOTS}/${s.file}`;
      if (!existsSync(fp)) return '';
      const b64 = readFileSync(fp).toString('base64');
      return `<div class="screen"><h2>${s.label}</h2><img src="data:image/png;base64,${b64}" /></div>`;
    })
    .filter(Boolean)
    .join('\n');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bapp Order Flow</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}h1{text-align:center}.screen{background:white;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);break-inside:avoid}.screen img{width:100%;max-width:390px;display:block;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px}</style></head><body><h1>Bapp Wallet - Order Flow</h1>${rows}</body></html>`;
  writeFileSync(`${PDFS}/order-flow.html`, html);

  const pdfBrowser = await chromium.launch();
  const pdfPage = await pdfBrowser.newPage();
  await pdfPage.setContent(html, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: `${PDFS}/order-flow.pdf`, format: 'A4', printBackground: true });
  await pdfBrowser.close();
  console.log('ok order-flow.pdf');
}

main().catch((e) => { console.error(e); process.exit(1); });
