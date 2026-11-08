import { test, expect } from '@playwright/test';

/**
 * Read-only smoke test against a DEPLOYED wallet, through the real `/eth`
 * proxy (no mock, no funds). Skipped unless ETH_PROD=1 so the normal suite
 * stays offline.
 *
 *   ETH_PROD=1 ETH_PROD_URL=https://wallet.bigt.ai \
 *     npx playwright test ethereum-prod.spec.ts
 */

const PROD = process.env.ETH_PROD === '1';
const BASE = process.env.ETH_PROD_URL || 'https://wallet.bigt.ai';
const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const BTC_ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';
const ETH_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

test.describe('Ethereum on a deployed wallet (read-only)', () => {
  test.skip(!PROD, 'set ETH_PROD=1 to run against a deployed wallet');

  test('loads the account and balances through the live /eth proxy', async ({ page }) => {
    // Plain EC wallet (unlocked on boot) and the deployment's own /eth proxy
    // (no eth.settings override).
    await page.addInitScript(
      ([key, pub, address]) => {
        const wallet = {
          keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }],
        };
        localStorage.setItem('device.walletEncryptedContent', JSON.stringify(wallet));
        localStorage.setItem('device.walletAddress', address);
        localStorage.removeItem('eth.settings');
      },
      [EC_KEY, EC_PUB, BTC_ADDRESS] as const
    );

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const nav = page.getByTestId('sidebar').getByRole('button', { name: 'Ethereum', exact: true });
    await expect(nav).toBeVisible({ timeout: 15000 });
    await nav.click();

    await expect(page.getByTestId('eth-screen')).toBeAttached({ timeout: 20000 });
    await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 20000 });
    // The proxy answered: no "not configured"/RPC error, both coins listed.
    await expect(page.getByTestId('eth-error')).toHaveCount(0);
    await expect(page.getByTestId('eth-asset-ETH')).toBeAttached();
    await expect(page.getByTestId('eth-asset-USDT')).toBeAttached();

    // The overview's buttons open the dedicated pages preselected: Deposit is
    // a direct receive for native ETH (address + QR, no issuer).
    await page.getByTestId('eth-deposit-ETH').click();
    await expect(page.getByTestId('deposit-screen')).toBeAttached({ timeout: 20000 });
    await expect(page.getByTestId('deposit-address')).toHaveText(ETH_ADDRESS, { timeout: 20000 });
    expect(await page.locator('[data-testid="deposit-address-card"] svg').count()).toBeGreaterThan(0);
    await page.goBack();

    // Withdraw opens the form with ETH preselected and gets a live fee from the
    // real node (no funds are moved).
    await expect(page.getByTestId('eth-screen')).toBeAttached({ timeout: 20000 });
    await page.getByTestId('eth-withdraw-ETH').click();
    await expect(page.getByTestId('withdraw-form')).toBeAttached({ timeout: 20000 });
    await page.getByTestId('withdraw-to').fill('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    await page.getByTestId('withdraw-amount').fill('0.001');
    await expect(page.getByTestId('withdraw-fee')).toContainText('Total debit', { timeout: 30000 });
    await expect(page.getByTestId('withdraw-gas-presets')).toContainText('Slow');
  });

  test('the exchange-style Deposit and Withdraw pages are deployed', async ({ page }) => {
    await page.addInitScript(
      ([key, pub, address]) => {
        const wallet = {
          keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }],
        };
        localStorage.setItem('device.walletEncryptedContent', JSON.stringify(wallet));
        localStorage.setItem('device.walletAddress', address);
      },
      [EC_KEY, EC_PUB, BTC_ADDRESS] as const
    );
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);

    // Deposit: coin -> network -> address (or the not-configured hint when the
    // deployment has no issuer configured).
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const deposit = page.getByTestId('sidebar').getByRole('button', { name: 'Deposit', exact: true });
    await expect(deposit).toBeVisible({ timeout: 15000 });
    await deposit.click();
    await expect(page.getByTestId('deposit-screen')).toBeAttached({ timeout: 20000 });
    await expect(page.getByTestId('deposit-tabs')).toBeAttached();
    await page.getByTestId('deposit-coin-USDT').click();
    await page.getByTestId('deposit-network-ethereum').click();
    await expect(
      page.getByTestId('deposit-address-card').or(page.getByTestId('deposit-open-settings'))
    ).toBeVisible({ timeout: 30000 });

    // Withdraw: the deploy stack serves SPA routes, so open it directly (the
    // deposit page is a stack screen without the drawer button).
    await page.goto(`${BASE}/withdraw`, { waitUntil: 'networkidle', timeout: 60000 });
    await expect(page.getByTestId('withdraw-screen')).toBeAttached({ timeout: 20000 });
    await page.getByTestId('withdraw-asset-ETH').click();
    await page.getByTestId('withdraw-network-ethereum').click();
    await page.getByTestId('withdraw-to').fill('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    await page.getByTestId('withdraw-amount').fill('0.001');
    await expect(page.getByTestId('withdraw-fee')).toContainText('Total debit', { timeout: 30000 });
  });
});
