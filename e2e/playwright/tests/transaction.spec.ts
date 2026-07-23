import { test, expect } from '@playwright/test';
import { waitForApp, getElement } from '../helpers';

test.describe('Transaction Screen', () => {
  test('displays the transaction screen (locked state)', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows no wallet prompt when no wallet exists', async ({ page }) => {
    await waitForApp(page);
    await expect(page.getByText('No Wallet Found')).toBeAttached({ timeout: 10000 });
  });

  test('shows create wallet and import buttons when no wallet', async ({ page }) => {
    await waitForApp(page);
    await expect(page.getByText('Create Wallet')).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Import Existing Wallet')).toBeAttached({ timeout: 5000 });
  });
});
