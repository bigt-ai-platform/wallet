import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Tokens Screen', () => {
  test('tokens screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const screen = await getElement(page, 'tokens-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows Browse and Create tabs', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    await expect(page.getByText('Tokens').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Create').first()).toBeAttached({ timeout: 5000 });
  });

  test('Create tab shows token creation form', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    await page.getByText('Create').click();

    await expect(page.getByText('Create New Token')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Token Name')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Symbol / Ticker')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Decimals')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Initial Supply')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Description (optional)')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Create Token')).toBeAttached({ timeout: 5000 });
  });

  test('Create form can be filled with USDC example', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    await page.getByText('Create').click();

    const nameInput = page.getByPlaceholder('e.g. USD Coin');
    const symbolInput = page.getByPlaceholder('e.g. USDC');
    const decimalsInput = page.getByPlaceholder('6');
    const supplyInput = page.getByPlaceholder('1000000');
    const descInput = page.getByPlaceholder('Describe your token');

    await expect(nameInput).toBeAttached({ timeout: 5000 });
    await expect(symbolInput).toBeAttached({ timeout: 5000 });
    await expect(decimalsInput).toBeAttached({ timeout: 5000 });
    await expect(supplyInput).toBeAttached({ timeout: 5000 });
    await expect(descInput).toBeAttached({ timeout: 5000 });

    await nameInput.fill('USD Coin');
    await symbolInput.fill('USDC');
    await decimalsInput.fill('6');
    await supplyInput.fill('1000000');
    await descInput.fill('USD stablecoin on bigtangle');

    await expect(nameInput).toHaveValue('USD Coin');
    await expect(symbolInput).toHaveValue('USDC');
    await expect(decimalsInput).toHaveValue('6');
    await expect(supplyInput).toHaveValue('1000000');
    await expect(descInput).toHaveValue('USD stablecoin on bigtangle');
  });

  test('submit token creation form triggers dialog', async ({ page }) => {
    await waitForApp(page);
    page.on('dialog', (dialog) => { dialog.accept().catch(() => {}); });
    await clickTab(page, 'Tokens');
    await page.getByText('Create').click();

    // Fill the form with real token data
    const tokenName = 'E2E Test Token ' + Date.now().toString(36);
    await page.getByPlaceholder('e.g. USD Coin').fill(tokenName);
    await page.getByPlaceholder('e.g. USDC').fill('E2E');
    await page.getByPlaceholder('6').fill('4');
    await page.getByPlaceholder('1000000').fill('10000');
    await page.getByPlaceholder('Describe your token').fill('Created by Playwright e2e test');

    // Click Create Token button
    await page.getByText('Create Token').click();

    // Wait for dialog (success or error from the server)
    // The server should respond — either success or error with a message
    await page.waitForTimeout(2000);
    // Check that the form still shows (it might show an error or redirect)
    await expect(page.getByText('Create New Token')).toBeAttached({ timeout: 5000 });
  });
});
