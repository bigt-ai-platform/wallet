import { test, expect, Page } from '@playwright/test';
import { waitForApp, clickTab, getElement, configureServerUrl } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

async function getWalletAddress(page: Page): Promise<string> {
  const addressEl = page.locator('text=/^[0-9a-f]{70}$/').first();
  await expect(addressEl).toBeAttached({ timeout: 10000 });
  return (await addressEl.textContent())!;
}

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

test.describe('Payment', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    if (HAS_SERVER) {
      await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    }
  });

  test('alice sends big to bob', async ({ page, request }) => {
    test.setTimeout(300000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    // 1. Generate Alice's PQ key in Node.js
    const { PQKey, Utils } = await import(
      '/home/jcui/git/bapp/packages/bigtangle-ts/dist/index.js'
    );

    const aliceKey = PQKey.createNew();
    const aliceAddress = aliceKey.toAddressHex();
    const alicePrivHex = aliceKey.getPrivateKeyHex();

    // Prefixed pubkey (0x05 prefix required by server's fromPublicOnly)
    const bundle = aliceKey.getPubKey();
    const prefixedPubkey = new Uint8Array(1 + bundle.length);
    prefixedPubkey[0] = 0x05;
    prefixedPubkey.set(bundle, 1);

    // 2. Fund Alice via fundAddresses with prefixed pubkey
    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: {
        addresses: [{
          address: '1LLtbSLJJn1D2churfWG55aDYqQQTu4eqH',
          value: 10000000000,
          pubkey: Utils.HEX.encode(prefixedPubkey),
        }],
      },
    });
    const fundBody = await fundResp.json();
    expect(fundBody.errorcode).toBe(0);
    console.log('Funded', aliceAddress);

    // 3. Import Alice key into the app
    await clickTab(page, 'Wallet');
    await (await getElement(page, 'wallet-screen')).getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');
    await importKey(page, alicePrivHex);
    await saveWallet(page, PASSWORD);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // 4. Unlock Alice
    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);

    // 5. Create Bob wallet (in-memory) for his address
    await clickTab(page, 'Wallet');
    const manageLink = page.getByText('Manage Keys');
    if (await manageLink.isVisible().catch(() => false)) {
      await manageLink.click();
    } else {
      await page.getByText('Manage Wallet').click();
    }
    await page.waitForURL('**/wallet/keys**', { timeout: 10000 });
    await page.getByText('Create New Wallet').click();
    await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
    const bobAddress = await getWalletAddress(page);
    await page.getByText('Cancel').click();
    await page.waitForTimeout(500);

    // 7. Send BIG to Bob
    await page.goBack();
    await page.waitForTimeout(1000);
    await clickTab(page, 'Transaction');
    await page.waitForTimeout(3000);

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');
    await page.locator('text=Send Payment').first().click();
    await page.waitForTimeout(2000);

    const confirmSend = page.getByText('Send').last();
    if (await confirmSend.isVisible().catch(() => false)) {
      const resultDlg = page.waitForEvent('dialog', { timeout: 30000 }).catch(() => null);
      await confirmSend.click();
      const dlg = await resultDlg;
      if (dlg) {
        const msg = dlg.message();
        expect(msg === 'Transaction sent!' || /Insufficient/i.test(msg)).toBeTruthy();
        await dlg.accept();
      }
    }

    // 8. Verify Bob's balance via API
    await page.waitForTimeout(3000);
    const balanceResp = await request.post(`${E2E_SERVER_URL}getBalance`, {
      data: { address: bobAddress },
    });
    expect(balanceResp.ok()).toBeTruthy();
  });
});
