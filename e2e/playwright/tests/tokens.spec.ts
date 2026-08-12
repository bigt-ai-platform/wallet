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
  if (d) await d.saveAs('/tmp/tokens-wallet-e2e.json');
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

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');

    const tokenId = 'aa' + Date.now().toString(16).padStart(14, '0');
    const tokenName = 'E2ETest_' + Date.now().toString(36);
    const key = sdk.PQKey.createNew();
    const prefixed = key.getPrefixedPublicKeyBytes();

    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: { addresses: [{ address: key.toAddressHex(), value: 10000000000, pubkey: sdk.Utils.HEX.encode(prefixed) }] },
    });
    expect((await fundResp.json()).errorcode).toBe(0);

    const { MemoInfo } = await import('../../../packages/bigtangle-ts/dist/net/bigtangle/core/MemoInfo.js');
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

    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);

    // Generate the wallet key in Node so we can fund by base58 (the network
    // spends classic base58 addresses; the app UI shows PQ hex).
    const { PQKey, Address, TestParams } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );
    const aliceKey = PQKey.createNew();
    const aliceBase58 = Address.fromKey(TestParams.get(), aliceKey).toString();
    const alicePrivHex = aliceKey.getPrivateKeyHex();

    // Import the key into the app
    await clickTab(page, 'Wallet');
    await page.getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**', { timeout: 10000 });
    await importKey(page, alicePrivHex);
    await saveWallet(page, PASSWORD);

    // Fund the wallet via API (base58 address; no pubkey — the server rejects
    // the PQ bundle version)
    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: {
        addresses: [{ address: aliceBase58, value: 10000000000 }],
      },
    });
    expect((await fundResp.json()).errorcode).toBe(0);
    console.log('Funded wallet', aliceBase58);

    // Wallet is unlocked after save — reload and unlock
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);
    await page.getByRole('tab', { name: /Transaction/ }).click();
    await page.waitForTimeout(3000);

    // Fill send form and send to Bob's base58 address
    const bobKey = PQKey.createNew();
    const bobAddress = Address.fromKey(TestParams.get(), bobKey).toString();

    let submitted = false;
    // Auto-accept dialogs (the send uses window.confirm on web; accepting it
    // resolves confirm to true so the send proceeds).
    page.on('dialog', (d) => d.accept().catch(() => {}));
    page.on('request', (req) => {
      if (req.url().includes('submitTransaction')) submitted = true;
    });

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');

    // The screen has a "Send Payment" heading AND button — click the button.
    await page.getByText('Send Payment').last().click();
    // Wait for the send to submit a transaction with the amount.
    await page.waitForTimeout(4000);

    // The send must actually submit a transaction with the amount.
    expect(submitted).toBe(true);
    console.log('UI send submitted transaction:', submitted);

    await page.waitForTimeout(3000);
    console.log('Payment flow completed');
  });
});
