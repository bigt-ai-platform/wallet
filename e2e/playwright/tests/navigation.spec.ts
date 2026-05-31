import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Navigation', () => {
  test('app loads and shows the transaction screen', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('all five tab labels are present', async ({ page }) => {
    await waitForApp(page);
    await expect(page.getByText('Transaction').first()).toBeAttached();
    await expect(page.getByText('Wallet').first()).toBeAttached();
    await expect(page.getByText('Market').first()).toBeAttached();
    await expect(page.getByText('Tokens').first()).toBeAttached();
    await expect(page.getByText('Settings').first()).toBeAttached();
  });

  test('navigate to Wallet tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Wallet');
    const wallet = await getElement(page, 'wallet-screen');
    await expect(wallet).toBeAttached({ timeout: 10000 });
  });

  test('navigate to Market tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    const market = await getElement(page, 'market-screen');
    await expect(market).toBeAttached({ timeout: 10000 });
  });

  test('navigate to Tokens tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const tokens = await getElement(page, 'tokens-screen');
    await expect(tokens).toBeAttached({ timeout: 10000 });
  });

  test('navigate to Settings tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    const settings = await getElement(page, 'settings-screen');
    await expect(settings).toBeAttached({ timeout: 10000 });
  });
});
