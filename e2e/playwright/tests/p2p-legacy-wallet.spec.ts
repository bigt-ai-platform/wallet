import { test, expect } from '@playwright/test';
import { waitForApp, clickTab } from '../helpers';

/**
 * Regression: a legacy secp256k1 (EC) wallet could not use P2P at all.
 *
 * P2P signs with ML-DSA and authenticates as a `did:key`, so the screen used to
 * set `identity = null` for `keyType === 'EC'`. The "My swaps" tab (where the
 * create form lives) then rendered "Unlock your wallet first" even though the
 * wallet was unlocked — the reported "create P2P buy shows unlock first" bug.
 *
 * The wallet in this test is the same legacy key as
 * `old-wallet-balance.spec.ts` (`java-encrypted.wallet`), stored as plain JSON
 * so the app treats it as unlocked and no password/fingerprint is needed. The
 * P2P engine is mocked; this asserts only the local identity/UI behaviour.
 */
const EC_PRIVATE_KEY = '02e0fbb15c9d7ea9012ff4b79857f1d171f36c70bf69a78c74d1b69f524aec9a';
const E2E_P2P_ENGINE_URL = process.env.E2E_P2P_ENGINE_URL || '';

test.describe('P2P with a legacy EC wallet', () => {
  test('shows the create form on My swaps instead of "unlock first"', async ({ page }) => {
    test.skip(!E2E_P2P_ENGINE_URL, 'requires a P2P-enabled web build (EXPO_PUBLIC_P2P_ENGINE_URL)');
    // Mock the settlement engine (host-agnostic: the build may bake a local
    // engine URL in CI or the public one). No chain is needed for this check.
    await page.route('**/capabilities', (route) => route.fulfill({ json: { rails: ['wechat'] } }));
    await page.route('**/public/orders*', (route) => route.fulfill({ json: { orders: [] } }));
    await page.route('**/profiles/mine*', (route) => route.fulfill({ json: { profiles: [] } }));
    await page.route('**/swaps/mine*', (route) => route.fulfill({ json: { swaps: [] } }));

    // A plain (unencrypted) EC wallet: no password, already unlocked.
    await page.addInitScript((privateKey: string) => {
      try {
        const wallet = {
          keys: [{
            address: '1LegacyEcWalletAddressPlaceholder',
            pubkey: '',
            privateKey,
            keyType: 'EC',
          }],
        };
        localStorage.setItem('device.walletEncryptedContent', JSON.stringify(wallet));
        localStorage.setItem('device.walletAddress', '1LegacyEcWalletAddressPlaceholder');
      } catch { /* ignore */ }
    }, EC_PRIVATE_KEY);

    await waitForApp(page);
    await clickTab(page, 'P2P');
    await page.getByTestId('p2p-tab-mine').click();

    // The create form (sell ad / buy bid) must be reachable…
    await expect(page.getByTestId('p2p-create')).toBeVisible();
    await expect(page.getByTestId('p2p-need-unlock')).toHaveCount(0);

    // …including the buy side, which is the reported flow.
    await page.getByTestId('p2p-side-buy').click();
    await expect(page.getByText('Buy order').first()).toBeVisible();
    await expect(page.getByTestId('p2p-create')).toBeEnabled();
  });
});
