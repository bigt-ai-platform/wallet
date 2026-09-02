import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, goToKeys } from '../helpers';

/** Lightweight wallet creation — creates a new wallet in the keys screen.
 *  Does NOT save with password (that step is tested once separately). */
async function createWalletQuick(page: Page): Promise<string> {
  await goToKeys(page);
  await page.getByText('Create New Wallet').click();
  await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
  // Wallet addresses are testnet base58 (e.g. m…/n…), not PQ hex.
  const addressEl = page.locator('text=/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/').first();
  await expect(addressEl).toBeAttached({ timeout: 10000 });
  return (await addressEl.textContent())!;
}

test.describe('Wallet Flow', () => {

  test('creates wallet and saves with password — address is valid', async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    // showSaveFilePicker (File System Access API) is desktop-only, can be
    // exposed as an undefined global, and opens a native dialog Playwright
    // cannot drive. Remove it so the app uses the anchor-download fallback,
    // which Playwright captures as a 'download' event.
    await page.addInitScript(() => {
      try {
        delete (globalThis as any).showSaveFilePicker;
      } catch {}
    });
    await waitForApp(page);
    const address = await createWalletQuick(page);
    expect(address).toMatch(/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/);

    // Save with password (tested once)
    await page.getByText('Save with Password').click();
    await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });
    await page.getByPlaceholder('Enter password (min 6 characters)').fill('TestPassword123!');
    await page.getByPlaceholder('Confirm password').fill('TestPassword123!');
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.getByText('Save Wallet').click();
    const d = await dl;
    if (d) await d.saveAs('/tmp/wallet-save-e2e.json');
    await page.waitForTimeout(2000);

    // Verify the encrypted wallet is stored and active: back on the idle
    // Manage Keys state the new address shows as Unlocked (password provided).
    await page.getByText('Done').first().click();
    await page.waitForTimeout(1000);
    await expect(page.getByText(address).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Unlocked').first()).toBeAttached({ timeout: 5000 });

    // The wallet must persist across a reload: on a fresh load it is Locked
    // (encrypted), and the saved password must unlock it — proving the
    // encrypted wallet file round-trips through storage.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await goToKeys(page);
    await expect(page.getByText(address).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Locked').first()).toBeAttached({ timeout: 5000 });
    await page.getByPlaceholder('Enter wallet password').fill('TestPassword123!');
    await page.getByText('Unlock Wallet').click();
    await expect(page.getByText('Unlocked').first()).toBeAttached({ timeout: 10000 });
    console.log('Wallet persisted, locked on reload, and re-unlocked with password');
  });

  test('transaction screen shows no wallet prompt', async ({ page }) => {
    await waitForApp(page);
    const screen = await getElement(page, 'transaction-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    await expect(screen.getByText('No Wallet Found')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Create Wallet')).toBeAttached({ timeout: 5000 });
  });
});
