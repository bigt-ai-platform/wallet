import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Adding a key to an existing wallet, then backing it up.
 *
 * Two directions are exercised, because they differ:
 *  - PQ-only -> add EC (Ethereum): the primary Bigt-Ai key must NOT move, the
 *    EC key is appended for the EVM screens. `ethereum.spec.ts` covers the gate
 *    and export; this file covers the plain-wallet path only where it differs.
 *  - EC-only (legacy) -> add PQ: the new PQ key becomes the Bigt-Ai key, so
 *    the primary address changes while the EC key keeps the Ethereum address
 *    and its funds. The old EC address must stay in the file (multi-key spend),
 *    and a backup taken afterwards must be usable again.
 */

const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const BTC_ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';
const PASSWORD = 'TestPassword123!';

type SavedKey = {
  keyType?: string;
  role?: string;
  address?: string;
  pubkey?: string;
  network?: string;
};

async function gotoKeys(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Keys', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByText('Manage Keys').first()).toBeAttached({ timeout: 10000 });
}

/**
 * Seed a plain (unencrypted) EC-only wallet, i.e. an old wallet file.
 * Guarded on the address so a reload does not re-seed over the added key.
 */
async function seedPlainEcWallet(page: Page) {
  await page.addInitScript(
    ([key, pub, address]) => {
      if (localStorage.getItem('device.walletAddress')) return;
      localStorage.setItem(
        'device.walletEncryptedContent',
        JSON.stringify({
          keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }],
        })
      );
      localStorage.setItem('device.walletAddress', address);
    },
    [EC_KEY, EC_PUB, BTC_ADDRESS] as const
  );
}

async function exportJson(page: Page): Promise<{ keys?: SavedKey[]; salt?: string; data?: string }> {
  const dl = page.waitForEvent('download', { timeout: 20000 });
  await page.getByTestId('keys-export-wallet').click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/^wallet_.*\.json$/);
  return JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
}

test('plain EC wallet: add PQ key, export both, both survive a reload', async ({ page }) => {
  await seedPlainEcWallet(page);
  await page.goto('/');
  await gotoKeys(page);

  await expect(page.getByTestId('keys-add-pq-key')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('keys-add-pq-key').click();

  const list = page.getByTestId('keys-key-list');
  await expect(list).toContainText('Bigt-Ai key (PQ)', { timeout: 15000 });
  await expect(list).toContainText('Ethereum address (EC)', { timeout: 15000 });

  const saved = await exportJson(page);
  expect(saved.keys).toHaveLength(2);
  // The PQ key takes the Bigt-Ai role; the legacy EC key keeps the Ethereum
  // address (and its funds) and its network so it can be re-derived.
  expect(saved.keys?.find((k) => k.keyType === 'PQ')?.role).toBe('bigt-ai');
  const ec = saved.keys?.find((k) => k.keyType === 'EC');
  expect(ec?.address).toBe(BTC_ADDRESS);
  expect(ec?.network).toBe('Main');

  // Plain wallets are never locked: the stored file must hold both keys after
  // a reload, not just the EC key that was there before the add.
  await page.goto('/');
  await page.waitForTimeout(3000);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('device.walletEncryptedContent') ?? '{}')
  );
  expect(stored.keys).toHaveLength(2);

  // …and the Keys screen renders both again.
  await gotoKeys(page);
  await expect(page.getByTestId('keys-key-list')).toContainText('Ethereum address (EC)', {
    timeout: 15000,
  });
  await expect(page.getByTestId('keys-key-list')).toContainText('Bigt-Ai key (PQ)', {
    timeout: 15000,
  });
});

test('encrypted EC wallet: add PQ key, encrypted export, reload + unlock keeps both', async ({ page }) => {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/');
  await gotoKeys(page);

  // Import the legacy EC key and save it with a password, so the added key has
  // to be re-encrypted with that same password rather than written as plain.
  await page.getByTestId('keys-import-ec').click();
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(EC_KEY);
  await page.getByText('Import Key', { exact: true }).click();
  await page
    .getByPlaceholder('Enter password (min 6 characters)')
    .locator('visible=true')
    .fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').locator('visible=true').fill(PASSWORD);
  await page.getByText('Save Wallet', { exact: true }).click();
  await expect(page.getByText('Wallet Saved Successfully!')).toBeAttached({ timeout: 15000 });
  await page.getByText('Done').first().click();

  await expect(page.getByTestId('keys-add-pq-key')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('keys-add-pq-key').click();
  await expect(page.getByTestId('keys-key-list')).toContainText('Bigt-Ai key (PQ)', {
    timeout: 15000,
  });

  // Still encrypted (salt/data, no plaintext keys) — the file is the backup of
  // both keys and must not need a different password.
  const saved = await exportJson(page);
  expect(saved.salt).toBeTruthy();
  expect(saved.data).toBeTruthy();
  expect(saved.keys).toBeUndefined();

  // Reload boots Locked; the same password unlocks the file holding both keys.
  await page.goto('/');
  await gotoKeys(page);
  await expect(page.getByText('Locked').first()).toBeAttached({ timeout: 15000 });
  await page.getByPlaceholder('Enter wallet password').locator('visible=true').fill(PASSWORD);
  await page.getByText('Unlock Wallet').locator('visible=true').click();
  await expect(page.getByTestId('keys-key-list')).toContainText('Bigt-Ai key (PQ)', {
    timeout: 15000,
  });
  await expect(page.getByTestId('keys-key-list')).toContainText('Ethereum address (EC)', {
    timeout: 15000,
  });
});
