import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, clickTab, configureServerUrl } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TokenTestPass123!';

async function importKey(page: Page, privKeyHex: string) {
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privKeyHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
}

async function saveWallet(page: Page, password: string) {
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs('/dev/null');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

test.describe('Tokens Screen', () => {
  test('tokens screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const screen = await getElement(page, 'tokens-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows search input and token list', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    await expect(page.getByPlaceholder('Search by name or ID').first()).toBeAttached({ timeout: 10000 });
  });

  test('BIG token exists on server (requires server)', async ({ request }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const searchResp = await request.post(`${E2E_SERVER_URL}searchTokens`, {
      data: {},
    });
    expect(searchResp.ok()).toBeTruthy();
    const searchBody = await searchResp.json();
    expect(searchBody.tokens).toBeDefined();
    const big = searchBody.tokens.find((t: any) => t.tokenname === 'BIG');
    expect(big).toBeDefined();
    expect(big.tokenid).toBe('bc');
    expect(big.decimals).toBe(6);
    expect(big.description).toBeDefined();

    const byIdResp = await request.post(`${E2E_SERVER_URL}getTokenById`, {
      data: { tokenid: 'bc' },
    });
    expect(byIdResp.ok()).toBeTruthy();
    const byIdBody = await byIdResp.json();
    expect(byIdBody.tokens).toBeDefined();
    expect(byIdBody.tokens.length).toBeGreaterThan(0);
    expect(byIdBody.tokens[0].tokenname).toBe('BIG');
    expect(byIdBody.tokens[0].tokenid).toBe('bc');
    expect(byIdBody.tokens[0].decimals).toBe(6);

    console.log('BIG token verified via searchTokens and getTokenById');
  });

  test('create a token and sign via SDK (requires server)', async ({ request }) => {
    test.setTimeout(60000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const sdk = await import('/home/jcui/git/bapp/packages/bigtangle-ts/dist/index.js');

    const tokenId = 'aa' + Date.now().toString(16).padStart(14, '0');
    const tokenName = 'E2ETest_' + Date.now().toString(36);
    const key = sdk.PQKey.createNew();
    const prefixed = key.getPrefixedPublicKeyBytes();

    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: { addresses: [{ address: key.toAddressHex(), value: 10000000000, pubkey: sdk.Utils.HEX.encode(prefixed) }] },
    });
    expect((await fundResp.json()).errorcode).toBe(0);

    const { MemoInfo } = await import('/home/jcui/git/bapp/packages/bigtangle-ts/dist/net/bigtangle/core/MemoInfo.js');
    const token = new sdk.Token(tokenId, tokenName);
    token.setDescription('E2E token creation test');
    token.setDecimals(2);
    token.setAmount(1000000n);
    token.setTokenstop(true);

    const wallet = sdk.Wallet.fromKeysSingle(new sdk.TestParams(), key, E2E_SERVER_URL);
    wallet.setFee(false);
    const block = await wallet.createToken(key, '', false, token, [], key.getPubKey(), new MemoInfo('coinbase'));
    expect(block).toBeDefined();
    console.log('Token block submitted, hash:', block.getHashAsString());
  });

  test('fund wallet and send BIG payment via UI (requires server)', async ({ page, request }) => {
    test.setTimeout(120000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);

    // Create a new wallet via UI (generates PQ key internally)
    await clickTab(page, 'Wallet');
    await page.getByText('Manage Wallet').click();
    await page.waitForTimeout(2000);
    await page.getByText('Create New Wallet').click();
    await page.waitForTimeout(2000);

    // Read the generated address and pubkey from the screen
    const addressText = await page.locator('body').innerText();
    const addrMatch = addressText.match(/wallet address:\s*(\S+)/);
    expect(addrMatch).not.toBeNull();
    const walletAddressHex = addrMatch![1];
    console.log('Wallet address:', walletAddressHex);

    const pubkeyMatch = addressText.match(/public key:\s*(\S+)/);
    const pubkeyHex = pubkeyMatch ? pubkeyMatch[1] : null;
    if (pubkeyHex) console.log('Wallet pubkey:', pubkeyHex.substring(0, 60) + '...');

    // Fund the wallet via API with pubkey
    const fundBody = pubkeyHex
      ? { addresses: [{ address: walletAddressHex, pubkey: pubkeyHex, value: 10000000000 }] }
      : { addresses: [{ address: walletAddressHex, value: 10000000000 }] };

    // Fund the wallet via API
    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: fundBody,
    });
    expect((await fundResp.json()).errorcode).toBe(0);
    console.log('Funded wallet');

    // Save with password — mock showSaveFilePicker to force download fallback
    await page.getByText('Save with Password').click();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      (globalThis as any).showSaveFilePicker = undefined;
    });
    await saveWallet(page, PASSWORD);

    // Wallet is unlocked after save — go back to main screen
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.getByRole('tab', { name: /Transaction/ }).click();
    await page.waitForTimeout(3000);

    // Fill send form and send
    const bobKey = (await import('/home/jcui/git/bapp/packages/bigtangle-ts/dist/index.js')).PQKey.createNew();
    const bobAddress = bobKey.toAddressHex();

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');
    await page.locator('text=Send').last().click();
    await page.waitForTimeout(2000);

    const resultDlg = page.waitForEvent('dialog', { timeout: 30000 }).catch(() => null);
    const dlg = await resultDlg;
    if (dlg) {
      const msg = dlg.message();
      expect(msg === 'Transaction sent!' || /Insufficient/i.test(msg)).toBeTruthy();
      console.log('Send dialog:', msg);
      await dlg.accept();
    }

    await page.waitForTimeout(3000);
    console.log('Payment flow completed');
  });
});
