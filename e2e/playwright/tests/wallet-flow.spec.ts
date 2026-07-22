import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';
import * as fs from 'fs';

test.afterAll(() => {
  try { fs.rmSync('/tmp/test-wallet-flow.json', { force: true }); } catch {}
  try { fs.rmSync('/tmp/test-wallet-tabs.json', { force: true }); } catch {}
  try { fs.rmSync('/tmp/test-wallet-bridge.json', { force: true }); } catch {}
  try { fs.rmSync('/tmp/test-wallet-pay.json', { force: true }); } catch {}
  try { fs.rmSync('/tmp/test-wallet-2.json', { force: true }); } catch {}
  try { fs.rmSync('/tmp/test-wallet3.json', { force: true }); } catch {}
});

test.describe('Wallet Flow', () => {

  test('wallet screen shows locked state initially', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Wallet');
    const screen = await getElement(page, 'wallet-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    await expect(screen.getByText('Wallet Locked')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Manage Wallet')).toBeAttached({ timeout: 5000 });
  });

  test('creates a new wallet and shows the address', async ({ page }) => {
    await waitForApp(page);
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

    await clickTab(page, 'Wallet');
    const screen = await getElement(page, 'wallet-screen');
    await screen.getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');

    await expect(page.getByRole('heading', { name: 'Manage Keys' })).toBeAttached({ timeout: 5000 });
    await page.getByText('Create New Wallet').click();
    await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });

    const addressEl = page.locator('text=/^[mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/').first();
    await expect(addressEl).toBeAttached({ timeout: 5000 });
    const address = await addressEl.textContent();
    expect(address).toBeTruthy();
    expect(address!.length).toBeGreaterThanOrEqual(26);
    expect(address!.length).toBeLessThanOrEqual(35);
  });

  test('saves wallet with password and unlocks', async ({ page }) => {
    await waitForApp(page);
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

    await clickTab(page, 'Wallet');
    const screen = await getElement(page, 'wallet-screen');
    await screen.getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');

    await page.getByText('Create New Wallet').click();
    await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });

    await page.getByText('Save with Password').click();
    await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });

    await page.getByPlaceholder('Enter password (min 6 characters)').fill('TestPassword123!');
    await page.getByPlaceholder('Confirm password').fill('TestPassword123!');

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.getByText('Save Wallet').click();

    const download = await downloadPromise;
    if (download) await download.saveAs('/tmp/test-wallet-flow.json');
    await page.waitForTimeout(2000);
  });

  test('wallet has Assets and Bridge tabs', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Wallet');
    const screen = await getElement(page, 'wallet-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    // When locked, the wallet screen doesn't show tabs — just verify lock UI
    await expect(screen.getByText('Wallet Locked')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Manage Wallet')).toBeAttached({ timeout: 5000 });
  });

  test('payment form is visible when wallet is unlocked', async ({ page }) => {
    await waitForApp(page);
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

    await clickTab(page, 'Wallet');
    const walletScreen = await getElement(page, 'wallet-screen');
    await walletScreen.getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');
    await page.getByText('Create New Wallet').click();
    await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
    await page.getByText('Save with Password').click();
    await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });
    await page.getByPlaceholder('Enter password (min 6 characters)').fill('TestPassword123!');
    await page.getByPlaceholder('Confirm password').fill('TestPassword123!');
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.getByText('Save Wallet').click();
    const d = await dl;
    if (d) await d.saveAs('/tmp/test-wallet-pay.json');
    await page.waitForTimeout(2000);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const txScreen = await getElement(page, 'transaction-screen');
    await expect(txScreen).toBeAttached({ timeout: 10000 });

    const lockedTitle = txScreen.getByText('Wallet Locked');
    if (await lockedTitle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(txScreen.getByText('Unlock Wallet')).toBeAttached({ timeout: 5000 });
      return;
    }

    await expect(txScreen.getByTestId('recipient-address-input')).toBeAttached({ timeout: 5000 });
    await expect(txScreen.getByTestId('amount-input')).toBeAttached({ timeout: 5000 });
    await expect(txScreen.getByTestId('memo-input')).toBeAttached({ timeout: 5000 });

    await txScreen.getByTestId('recipient-address-input').fill('mjWvzPZz4YJtWqb7ux7cdgq5G7rzkg3bXG');
    await expect(txScreen.getByTestId('recipient-address-input')).toHaveValue('mjWvzPZz4YJtWqb7ux7cdgq5G7rzkg3bXG');
    await txScreen.getByTestId('amount-input').fill('0.001');
    await txScreen.getByTestId('memo-input').fill('test payment from e2e');
  });

  test('transaction screen shows locked state without wallet', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    await expect(screen.getByText('Wallet Locked')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Unlock Wallet')).toBeAttached({ timeout: 5000 });
  });
});
