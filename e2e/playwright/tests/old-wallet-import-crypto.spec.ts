import { test, expect } from '@playwright/test';
import path from 'node:path';

// Regression for the "bad decrypt" legacy .wallet import failure: the bundle
// must derive the AES key from the password's UTF-16BE bytes (Java clients),
// which requires a single bigtangle-ts copy in the build. Needs no infra — the
// decrypt happens entirely in the browser.
const WALLET_FILE = path.resolve(
  __dirname,
  '../../../packages/bigtangle-ts/test/oldwallet/java-encrypted.wallet',
);
const OLD_PASSWORD = 'bigtangle';
const EC_ADDRESS = 'mkzY5JpvC9hMb59rh4hHDjx3JvnFqWFBC7';

test.describe('Old .wallet import (crypto)', () => {
  test('decrypts the Java-encrypted .wallet', async ({ page }) => {
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

    await expect(page.getByText('Enter Old Wallet Password').first()).toBeAttached({
      timeout: 15000,
    });
    await page
      .locator(
        'input[placeholder="Enter old wallet password"], [data-placeholder="Enter old wallet password"]',
      )
      .first()
      .fill(OLD_PASSWORD);
    await page.getByText('Continue').first().click();

    // Decryption succeeded -> the new-password step with the recovered address.
    await expect(page.getByText('Set Wallet Password').first()).toBeAttached({
      timeout: 30000,
    });
    await expect(page.getByText(EC_ADDRESS).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText(/bad decrypt/)).toHaveCount(0);
  });
});
