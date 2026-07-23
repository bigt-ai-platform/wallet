import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

/** Lightweight wallet creation — creates a new wallet in the keys modal.
 *  Does NOT save with password (that step is tested once separately). */
async function createWalletQuick(page: Page): Promise<string> {
  await clickTab(page, 'Wallet');
  await (await getElement(page, 'wallet-screen')).getByText('Manage Wallet').click();
  await page.waitForURL('**/wallet/keys**');
  await page.getByText('Create New Wallet').click();
  await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
  const addressEl = page.locator('text=/^[0-9a-f]{70}$/').first();
  await expect(addressEl).toBeAttached({ timeout: 10000 });
  return (await addressEl.textContent())!;
}

test.describe('Wallet Flow', () => {

  test('wallet screen shows locked state initially', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Wallet');
    const screen = await getElement(page, 'wallet-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    await expect(screen.getByText('Wallet Locked')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Manage Wallet')).toBeAttached({ timeout: 5000 });
  });

  test('creates wallet and saves with password — address is valid', async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await waitForApp(page);
    const address = await createWalletQuick(page);
    expect(address).toMatch(/^[0-9a-f]{70}$/);

    // Save with password (tested once)
    await page.getByText('Save with Password').click();
    await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });
    await page.getByPlaceholder('Enter password (min 6 characters)').fill('TestPassword123!');
    await page.getByPlaceholder('Confirm password').fill('TestPassword123!');
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.getByText('Save Wallet').click();
    const d = await dl;
    if (d) await d.saveAs('/dev/null');
    await page.waitForTimeout(2000);
  });

  test('transaction screen shows no wallet prompt', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    await expect(screen.getByText('No Wallet Found')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Create Wallet')).toBeAttached({ timeout: 5000 });
  });
});
