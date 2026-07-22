import { test, expect } from '@playwright/test';
import { waitForApp, getElement } from '../helpers';

test.describe('Transaction Screen', () => {
  test('displays the transaction screen (locked state)', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows unlock prompt when wallet is locked', async ({ page }) => {
    await waitForApp(page);
    await expect(page.getByText('Wallet Locked')).toBeAttached({ timeout: 10000 });
  });

  test('shows unlock button when wallet is locked', async ({ page }) => {
    await waitForApp(page);
    await expect(page.getByText('Unlock Wallet')).toBeAttached({ timeout: 10000 });
  });
});
