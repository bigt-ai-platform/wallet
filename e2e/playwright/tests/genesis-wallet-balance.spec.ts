import { test, expect } from '@playwright/test';
import { waitForApp, configureServerUrl } from '../helpers';
import path from 'node:path';

// e2e test for the test-net genesis wallet:
//   loads helper/test/wallet/genesis-wallet.json (seed 01, unencrypted) in the
//   app and verifies the balance screen shows its on-chain bc UTXOs.
// Requires the local infra running: L0 http://127.0.0.1:24089, L1 127.0.0.1:24086
// (e.g. `cd ../blockchain && helper/fulltest/remote.sh infra`).
const WALLET_FILE = '/home/jcui/git/blockchain/helper/test/wallet/genesis-wallet.json';
const L0_URL = process.env.E2E_L0_URL || 'http://127.0.0.1:24089';
const L1_URL = process.env.E2E_L1_URL || 'http://127.0.0.1:24086';
const GENESIS_ADDRESS = 'mnvGDASDFGpHXycAadQC4STYFNwfhfTGsf';

test.describe('Genesis wallet balance (helper/test/wallet/genesis-wallet.json)', () => {
  test('loads the wallet and shows a non-empty bc balance', async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    // showSaveFilePicker is desktop-only and blocks the anchor-download
    // fallback; not used here, but keep the app deterministic.
    await page.addInitScript(() => {
      try {
        delete (globalThis as any).showSaveFilePicker;
      } catch {}
    });

    // Point the app at the local test infra.
    await waitForApp(page);
    await configureServerUrl(page, L0_URL, L1_URL);

    // 1) Open the Keys screen and load the unencrypted genesis wallet file.
    await page.goto('/home/keys');

    // The app creates a detached <input type=file> and calls input.click(),
    // which opens the OS picker — captured by Playwright as a filechooser.
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.getByText('Load from File').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(path.resolve(WALLET_FILE));

    // Plain (unencrypted) wallet -> no password step; "Load Wallet" shows.
    await expect(page.getByText('Load Wallet').first()).toBeAttached({ timeout: 10000 });
    // The step has a "Load Wallet" page title AND a "Load Wallet" button; the
    // button is the last match.
    await page.getByText('Load Wallet').last().click();

    // The wallet is stored; the load flow ends in a "done" state.
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({ timeout: 10000 });
    await page.getByText('Done').first().click();
    // Back on the idle Manage Keys state: wallet shows the genesis address and
    // is unlocked (plain wallets are never locked).
    await expect(page.getByText(GENESIS_ADDRESS).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Unlocked').first()).toBeAttached({ timeout: 10000 });

    // 2) Balance screen: should show the genesis wallet's bc UTXOs.
    await page.goto('/balance');
    await expect(page.getByTestId('balance-screen')).toBeAttached({ timeout: 10000 });

    // Wait for the balance to load; assert it is populated (not empty).
    await expect(async () => {
      const empty = await page.getByText('No UTXOs found for the selected filters.').count();
      const utxoText = await page.locator('text=/\\d+ UTXOs?/').count();
      expect(empty).toBe(0);
      expect(utxoText).toBeGreaterThan(0);
    }).toPass({ timeout: 20000 });

    // The count is non-zero and the wallet address appears.
    const count = await page.locator('text=/\\d+ UTXOs?/').first().textContent();
    const parsed = parseInt((count || '').replace(/\D+/g, ''), 10);
    expect(parsed).toBeGreaterThan(0);

    // The genesis address shows in the loaded wallet info (Keys screen).
    await page.goto('/home/keys');
    await expect(page.getByText(GENESIS_ADDRESS).first()).toBeAttached({ timeout: 10000 });
  });
});
