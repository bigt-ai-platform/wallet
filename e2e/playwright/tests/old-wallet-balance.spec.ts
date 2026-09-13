import { test, expect } from '@playwright/test';
import { waitForApp, configureServerUrl, clickTab, fundFromGenesisWallet, waitForConfirmedBc } from '../helpers';
import path from 'node:path';

// e2e test for the legacy .wallet import -> balance fix:
//   imports the old Java protobuf wallet (packages/bigtangle-ts/test/oldwallet/
//   java-encrypted.wallet, password "bigtangle", legacy secp256k1 EC key,
//   testnet address mkzY5JpvC9hMb59rh4hHDjx3JvnFqWFBC7) and verifies the
//   wallet's balance is shown. The balance/UTXO queries must derive the EC
//   pubKeyHash (not a PQ hash) — regression for the old-wallet import bug.
// Requires the local infra running: L0 http://127.0.0.1:24089, L1 127.0.0.1:24086
// (e.g. `cd ../blockchain && helper/fulltest/remote.sh infra`).
const WALLET_FILE = path.resolve(__dirname, '../../../packages/bigtangle-ts/test/oldwallet/java-encrypted.wallet');
const OLD_PASSWORD = 'bigtangle';
const NEW_PASSWORD = 'TestPassword123!';
const L0_URL = (process.env.E2E_L0_URL || 'http://127.0.0.1:24089') + '/';
const L1_URL = process.env.E2E_L1_URL || 'http://127.0.0.1:24086';
const EC_ADDRESS = 'mkzY5JpvC9hMb59rh4hHDjx3JvnFqWFBC7';
const EC_PRIVATE_KEY = '02e0fbb15c9d7ea9012ff4b79857f1d171f36c70bf69a78c74d1b69f524aec9a';

test.describe('Old .wallet import shows balance (java-encrypted.wallet)', () => {
  test('imports the legacy wallet and shows its funded balance', async ({ page }) => {
    test.setTimeout(240000);
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.addInitScript(() => {
      try {
        delete (globalThis as any).showSaveFilePicker;
      } catch {}
    });

    // 0) Fund the legacy EC address with real on-chain BIG from the genesis
    //    wallet (ML-DSA seed 0x01), the same way the Java remote tests do.
    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
    const ecKey = sdk.ECKey.fromPrivate(sdk.Utils.HEX.decode(EC_PRIVATE_KEY), true);
    await fundFromGenesisWallet(L0_URL, [ecKey], BigInt(1e8));
    await waitForConfirmedBc(ecKey, L0_URL);

    // 1) Point the app at the local test infra.
    await waitForApp(page);
    await configureServerUrl(page, L0_URL.replace(/\/$/, ''), L1_URL);

    // 2) Import the old .wallet via Manage Keys -> Import Old Wallet.
    await clickTab(page, 'Keys');
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.getByText('Import Old Wallet (.wallet)').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(WALLET_FILE);

    // Encrypted file -> old-password step.
    await expect(page.getByText('Enter Old Wallet Password').first()).toBeAttached({ timeout: 10000 });
    await page.locator('input[placeholder="Enter old wallet password"], [data-placeholder="Enter old wallet password"]').first().fill(OLD_PASSWORD);
    await page.getByText('Continue').first().click();

    // Decrypted -> set a new wallet password (min 6 chars) to store it.
    await expect(page.getByText('Set Wallet Password').first()).toBeAttached({ timeout: 30000 });
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill(NEW_PASSWORD);
    await pwInputs.nth(1).fill(NEW_PASSWORD);
    await page.getByText('Save Wallet').first().click();

    // Stored + unlocked; the legacy base58 address shows on the Keys screen.
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({ timeout: 30000 });
    await page.getByText('Done').first().click();
    await expect(page.getByText(EC_ADDRESS).first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Unlocked').first()).toBeAttached({ timeout: 10000 });

    // 3) Balance screen: the funded UTXO shows (history/address query path).
    await clickTab(page, 'Balance');
    await expect(page.getByTestId('balance-screen')).toBeAttached({ timeout: 10000 });
    await expect(async () => {
      const empty = await page.getByText('No UTXOs found for the selected filters.').count();
      const utxoText = await page.locator('text=/\\d+ UTXOs?/').count();
      expect(empty).toBe(0);
      expect(utxoText).toBeGreaterThan(0);
    }).toPass({ timeout: 30000 });

    // 4) Payment screen: the token list comes from getBalances — this is the
    //    fixed path (EC pubKeyHash). The dropdown shows "BIG (<n>)" with the
    //    funded, non-zero balance (funding amounts accumulate across runs).
    //    The balance screen has no sidebar — go back first.
    await page.getByRole('button', { name: 'Back' }).click();
    await clickTab(page, 'Payment');
    await expect(page.getByTestId('transaction-screen').first()).toBeAttached({ timeout: 30000 });
    await expect(page.getByTestId('token-select').first()).toContainText(/BIG \([1-9]\d*\)/, { timeout: 30000 });
    await expect(page.locator('text=/Available: [1-9]\\d* BIG/').first()).toBeAttached({ timeout: 10000 });
  });
});
