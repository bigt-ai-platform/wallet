import { test, expect, type Page } from '@playwright/test';

/**
 * Wallet-file save on the web build.
 *
 * The class of bug this guards: "Back up wallet file" produced no file. On the
 * Android app the save goes through the native WalletFile plugin (no picker and
 * no `<a download>` in a WebView); in a browser it must use the File System
 * Access picker when available and the anchor download otherwise. The anchor
 * path is asserted end-to-end in ethereum.spec.ts ("a legacy PQ-only wallet…"),
 * this spec covers the picker path.
 */

const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const BTC_ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';

type PickerCall = { suggestedName?: string; content?: string };

/** Plain EC wallet: loaded as-is, so the Keys screen is unlocked on boot. */
async function seedPlainWallet(page: Page) {
  await page.addInitScript(
    ([key, pub, address]) => {
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

/** Record what the app hands to the File System Access picker. */
async function stubSavePicker(page: Page) {
  await page.addInitScript(() => {
    (globalThis as unknown as { __pickerCalls: PickerCall[] }).__pickerCalls = [];
    (globalThis as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker =
      async (options: { suggestedName?: string }) => ({
        createWritable: async () => ({
          write: async (blob: Blob) => {
            (globalThis as unknown as { __pickerCalls: PickerCall[] }).__pickerCalls.push({
              suggestedName: options?.suggestedName,
              content: await blob.text(),
            });
          },
          close: async () => {},
        }),
      });
  });
}

async function gotoKeys(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Keys', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByText('Manage Keys').first()).toBeAttached({ timeout: 10000 });
}

test('back up wallet file writes the JSON through the save picker', async ({ page }) => {
  await stubSavePicker(page);
  await seedPlainWallet(page);
  await page.goto('/');
  await gotoKeys(page);

  await page.getByTestId('keys-export-wallet').click();

  type WithCalls = { __pickerCalls: PickerCall[] };
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as WithCalls).__pickerCalls.length), {
      timeout: 20000,
    })
    .toBe(1);

  const calls = await page.evaluate(() => (globalThis as unknown as WithCalls).__pickerCalls);
  expect(calls[0].suggestedName).toMatch(/^wallet_.*\.json$/);
  const saved = JSON.parse(calls[0].content ?? '') as {
    keys?: Array<{ address?: string; keyType?: string }>;
  };
  expect(saved.keys?.some((k) => k.keyType === 'EC' && k.address === BTC_ADDRESS)).toBe(true);
});
