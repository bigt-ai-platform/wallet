import { test, expect } from '@playwright/test';
import path from 'node:path';

// Unencrypted legacy .wallet import: no password is needed to read the file,
// so the wallet is imported and stored immediately (plain wallet JSON, which
// the app treats as unlocked). Needs no infra — everything happens in the
// browser.
const WALLET_FILE = path.resolve(
  __dirname,
  '../../../packages/bigtangle-ts/test/oldwallet/cui.wallet',
);
const EC_ADDRESS = '16UmWyaGYmCWew2KGE1eUjiR1yMBdFSwKL';

test.describe('Old .wallet import (unencrypted)', () => {
  test('imports without prompting for a password', async ({ page }) => {
    test.setTimeout(60000);
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.addInitScript(() => {
      try {
        delete (globalThis as any).showSaveFilePicker;
      } catch {}
    });

    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3000);

    const menu = page.getByRole('button', { name: 'Open navigation menu' });
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.waitForTimeout(400);
    }
    await page.getByRole('button', { name: 'Keys', exact: true }).first().click();
    await page.waitForTimeout(1500);

    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.getByText('Import Old Wallet (.wallet)').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(WALLET_FILE);

    // No password prompt at all: straight to the saved state.
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({
      timeout: 20000,
    });
    await expect(page.getByText(EC_ADDRESS).first()).toBeAttached({ timeout: 10000 });

    await page.getByText('Done').first().click();
    await expect(page.getByText(EC_ADDRESS).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Unlocked').first()).toBeAttached({ timeout: 10000 });
  });
});
