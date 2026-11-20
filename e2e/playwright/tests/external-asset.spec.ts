import { test, expect, type Page } from '@playwright/test';
import { startDistributorMock } from '../../distributor-mock.mjs';

/**
 * External assets (`/external-asset`) against the contract mock.
 *
 * No chain, no distributor account, no funds: `e2e/distributor-mock.mjs`
 * implements the same API as `services/asset-issuer`, including the funding
 * rails, and serves a fixed 1000.000000 balance per asset.
 *
 * Needs a web build (Expo web on `APP_URL`, default `http://localhost:8081`).
 * Not run in CI here; run with:
 *   APP_URL=http://localhost:8081 npx playwright test e2e/playwright/tests/external-asset.spec.ts
 */

type Mock = { url: string; close: () => Promise<void> };

const startMock = startDistributorMock as unknown as (port?: number) => Promise<Mock>;

// Same plain EC wallet the Ethereum spec uses: unlocked on boot, and its
// address is the distributor account id.
const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';

let mock: Mock;

test.beforeEach(async () => {
  mock = await startMock(0);
});

test.afterEach(async () => {
  await mock.close();
});

/** Plain (unlocked) wallet + a distributor pointing at the mock. */
async function injectWalletAndDistributor(page: Page, apiUrl: string) {
  await page.addInitScript(
    ([key, pub, address, url]) => {
      localStorage.setItem(
        'device.walletEncryptedContent',
        JSON.stringify({ keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }] }),
      );
      localStorage.setItem('device.walletAddress', address);
      const settings = JSON.stringify({ apiUrl: url, token: 'e2e', accountId: address });
      // `device` joins key paths with '.', so the KV key is external.distributor.
      localStorage.setItem('external.distributor', settings);
      localStorage.setItem('device.external.distributor', settings);
    },
    [EC_KEY, EC_PUB, ADDRESS, apiUrl] as const,
  );
}

/** Open the drawer and go to the external-assets screen (client-side nav: a
 *  static server has no SPA fallback, so a deep link would 404). */
async function gotoExternalAssets(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'External assets', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByTestId('ext-screen')).toBeAttached({ timeout: 15000 });
}

test.describe('external assets', () => {
  test('shows balances and the bank funding reference', async ({ page }) => {
    await injectWalletAndDistributor(page, mock.url);
    await page.goto('/');
    await gotoExternalAssets(page);

    // The mock reports 1000.000000 for every asset; HKD is the first row.
    await expect(page.getByTestId('ext-balance-hkd')).toContainText('1,000');

    // HKD is a bank rail: instructions + a reference, never an EVM address.
    await expect(page.getByTestId('ext-deposit')).toBeVisible();
    await expect(page.getByTestId('ext-deposit-ref')).toContainText('HKD-');
  });

  test('submits a transfer and reports it', async ({ page }) => {
    await injectWalletAndDistributor(page, mock.url);
    await page.goto('/');
    await gotoExternalAssets(page);

    await page.getByTestId('ext-to').fill('wallet-2');
    await page.getByTestId('ext-amount').fill('1.5');
    await page.getByTestId('ext-submit').click();

    await expect(page.getByText(/Request submitted/i)).toBeVisible();
    // The mock debits 1.5 and the statement row appears.
    await expect(page.getByTestId('ext-row-transfer_1')).toBeVisible();
  });

  test('surfaces external balances on the home screen', async ({ page }) => {
    await injectWalletAndDistributor(page, mock.url);
    await page.goto('/');

    await expect(page.getByTestId('home-external-assets')).toBeVisible();
    await expect(page.getByTestId('home-external-hkd')).toContainText('HKD');
    await expect(page.getByTestId('home-external-hkd')).toContainText('1,000');
  });

  test('stays hidden without a distributor', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('home-external-assets')).toHaveCount(0);
  });
});
