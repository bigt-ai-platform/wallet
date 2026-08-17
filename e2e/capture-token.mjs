#!/usr/bin/env node
/**
 * Capture token-flow screenshots (token browse/list, token search, token
 * creation form, and the created token in the list) and generate token-flow.pdf.
 *
 * Creates a REAL token on the L0 chain via the SDK (genesis-funded) so the
 * browse list and search show real confirmed token data:
 *   - token browse (confirmed token list)
 *   - token search (filter by name)
 *   - token creation form (the "how to create" guide)
 *   - the created token appearing in the list
 *
 * Usage: APP_URL=... E2E_SERVER_URL=... E2E_L1_URL=... node capture-token.mjs
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

const sdk = await import('../packages/bigtangle-ts/dist/index.js');
const bcToken = sdk.NetworkParameters.BIGTANGLE_TOKENID_STRING;

async function postJson(endpoint, body) {
  const res = await fetch(SVR + endpoint, {
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

async function main() {
  // ---- 1. Create a real confirmed token on L0 (genesis-funded) ----
  const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
  const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], SVR);
  wallet.setServerURL(SVR);
  wallet.setFee(false);

  const genesisAddr = sdk.Address.fromKey(sdk.TestParams.get(), genesisKey).toString();
  await postJson('fundAddresses', { addresses: [{ address: genesisAddr, value: 100000000000 }] });

  const waitBc = async () => {
    for (let i = 0; i < 60; i++) {
      const cands = await wallet.calculateAllSpendCandidates(null, false);
      if (cands.some((c) => c.getUTXO()?.getTokenId() === bcToken && c.getUTXO()?.isConfirmed?.())) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('genesis BIG not confirmed');
  };
  await waitBc();
  console.log('genesis funded + confirmed');

  // Wait for a few confirmed beacon (reward) blocks so a token-creation block
  // isn't built on an unstable, still-reorganising chain tip and orphaned.
  const waitChainStable = async (minBeacons = 4) => {
    for (let i = 0; i < 40; i++) {
      const resp = await postJson('getAllConfirmedReward', {});
      const rewards = resp.txReward || [];
      if (rewards.length >= minBeacons) return rewards.length;
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log('WARNING: chain not stable after wait, continuing anyway');
    return 0;
  };
  await waitChainStable();
  console.log('chain stable (confirmed reward blocks)');

  // Create + confirm a token. The L0 chain occasionally orphans a token-creation
  // block (fork), so retry with a fresh key until one confirms. Each mint is
  // named "Demo Token <id-tail>" — unique per run so repeated runs against a
  // persistent chain don't pile up several identical "Demo Token" cards, and
  // the browse/search/list screenshots match the create form (which is filled
  // with this same name below).
  const createConfirmedToken = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tokenKey = sdk.PQKey.createNew();
      const tokenid = sdk.Utils.HEX.encode(tokenKey.getPrefixedPublicKeyBytes());
      const tokenName = `Demo Token ${tokenid.slice(-4).toUpperCase()}`;
      const token = new sdk.Token(tokenid, tokenName);
      token.setDescription('A demo token for the e2e flow');
      token.setDecimals(2);
      token.setAmount(BigInt(1000000));
      token.setTokenstop(true);
      token.setTokentype(sdk.TokenType.token);

      const tokenAddr = sdk.Address.fromKey(sdk.TestParams.get(), tokenKey).toString();
      await postJson('fundAddresses', { addresses: [{ address: tokenAddr, value: 10000000000 }] });

      const addr = new sdk.MultiSignAddress(tokenid, '', sdk.Utils.HEX.encode(tokenKey.getPrefixedPublicKeyBytes()), 0);
      const block = await wallet.createToken(tokenKey, '', false, token, [addr], tokenKey.getPubKey(), new sdk.MemoInfo('coinbase'));
      if (!block) { console.log('createToken returned no block, retrying'); continue; }
      const signed = await wallet.multiSign(tokenid, genesisKey, null);
      if (!signed) { console.log('multiSign failed, retrying'); continue; }
      console.log(`Token ${tokenName} submitted (attempt ${attempt + 1})`);

      // Wait for the token to be CONFIRMED — poll searchTokens (the exact query
      // the app's browse screen uses, which returns only CONFIRMED tokens). The
      // name is fixed, so match by this run's unique tokenid.
      for (let i = 0; i < 40; i++) {
        const resp = await postJson('searchTokens', { name: '' });
        const tokens = resp.tokens || [];
        if (tokens.some((t) => t.tokenid === tokenid)) {
          console.log(`Token ${tokenName} confirmed on L0`);
          return { tokenName, tokenid };
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log(`Token ${tokenName} not confirmed, retrying`);
    }
    throw new Error('No token confirmed after retries');
  };

  const { tokenName } = await createConfirmedToken();
  console.log(`Capturing token flow for ${tokenName}`);

  // ---- 2. App UI: browse / search / create form ----
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { delete globalThis.showSaveFilePicker; } catch {} });

  await page.goto(APP, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await configureAppUrls(page, SVR, L1);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Screenshot 1: token browse list (BIG + created token).
  await page.getByRole('tab', { name: 'Tokens', exact: true }).first().click();
  await page.getByText(tokenName).first().waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/token-01-browse.png` });
  console.log('ok token-01-browse');

  // Screenshot 2: token search (filter by name → only the created token).
  await page.getByPlaceholder('Search by name or ID').first().fill(tokenName);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/token-02-search.png` });
  console.log('ok token-02-search');

  // Screenshot 3: token creation form (the "how to create" guide, filled with
  // the same name as the token that was actually minted above).
  await page.getByTestId('tokens-screen').getByText('Create', { exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByPlaceholder('e.g. USD Coin').fill(tokenName);
  await page.getByPlaceholder('e.g. USDC').fill('DEMO');
  await page.getByPlaceholder('6').fill('2');
  await page.getByPlaceholder('1000000').fill('1000000');
  await page.getByPlaceholder('Describe your token').fill('A demo token for the e2e flow');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/token-03-create-form.png` });
  console.log('ok token-03-create-form');

  // Screenshot 4: back to the browse tab, search cleared — the created token is listed.
  await page.getByTestId('tokens-screen').getByRole('tab', { name: 'Tokens' }).click();
  await page.waitForTimeout(800);
  await page.getByPlaceholder('Search by name or ID').first().fill('');
  await page.getByText(tokenName).first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/token-04-created.png` });
  console.log('ok token-04-created');

  await browser.close();

  // ---- 3. Generate token-flow.pdf ----
  const SHOT_FILES = [
    { file: 'token-01-browse.png', label: 'Token List (browse)' },
    { file: 'token-02-search.png', label: 'Token Search (by name)' },
    { file: 'token-03-create-form.png', label: 'Create Token (form)' },
    { file: 'token-04-created.png', label: 'Created Token in List' },
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

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bapp Token Flow</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}h1{text-align:center}.screen{background:white;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);break-inside:avoid}.screen img{width:100%;max-width:390px;display:block;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px}</style></head><body><h1>Bapp Wallet - Token Flow</h1>${rows}</body></html>`;
  writeFileSync(`${PDFS}/token-flow.html`, html);

  const pdfBrowser = await chromium.launch();
  const pdfPage = await pdfBrowser.newPage();
  await pdfPage.setContent(html, { waitUntil: 'networkidle' });
  await pdfPage.pdf({ path: `${PDFS}/token-flow.pdf`, format: 'A4', printBackground: true });
  await pdfBrowser.close();
  console.log('ok token-flow.pdf');
}

main().catch((e) => { console.error(e); process.exit(1); });
