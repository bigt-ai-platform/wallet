import { test, expect } from '@playwright/test';
import path from 'node:path';

// Regression for importing an aifeeds/dai wallet backup into the wallet app.
// dai writes the same encrypted payload as the wallet ({keys, credentials}) but
// adds a TOP-LEVEL `chatKeys` map outside the ciphertext (chat-key backup). The
// wallet "Load from file" path must ignore that extra field and recover the key.
// If it ever starts rejecting unknown top-level fields, this import breaks with
// "Unrecognized wallet file format" — the failure this spec pins.
//
// Needs no infra: decryption is entirely client-side.
const WALLET_FILE = path.resolve(
  __dirname,
  '../fixtures/aifeeds-wallet-backup.wallet.json',
);
const PASSWORD = 'bigtangle';
const MAINNET_ADDRESS = '1HunxyPHUo6sAoduVLTKSt2RcyJc7Z4P9e';

test.describe('aifeeds/dai wallet backup import', () => {
  test('imports a backup that carries top-level chatKeys', async ({ page }) => {
    test.setTimeout(60000);
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.accept().catch(() => {});
    });
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

    // Load from file → pick the dai backup.
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.getByText('Load from File').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(WALLET_FILE);

    // Encrypted file → password step.
    await expect(page.getByText('Load Wallet').first()).toBeAttached({ timeout: 15000 });
    await page
      .locator(
        'input[placeholder="Enter wallet password"], [data-placeholder="Enter wallet password"]',
      )
      .first()
      .fill(PASSWORD);
    await page.getByText('Load Wallet').last().click();

    // Success: the recovered address is shown and no format/decrypt error ran.
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({
      timeout: 30000,
    });
    await expect(page.getByText(MAINNET_ADDRESS).first()).toBeAttached({ timeout: 10000 });
    expect(dialogs.join('\n')).not.toMatch(/Unrecognized wallet file format|bad decrypt|Failed to load wallet/i);
  });
});
