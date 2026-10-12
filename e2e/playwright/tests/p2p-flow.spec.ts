import { test, expect, Browser, Page } from '@playwright/test';
import { clickTab, goToKeys } from '../helpers';

const el = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/**
 * Full P2P settlement flow against a running p2p-engine (started by
 * e2etest.sh as `p2p-ui`, mem store, no chain check): seller lists → buyer
 * matches → seller locks escrow → buyer pulls the CNY instructions → buyer
 * claims the transfer.
 *
 * Two isolated browser contexts each create a fresh wallet, so the two sides
 * have distinct PQ dids. The engine's read routes are party-scoped, so each
 * side signs with its own key — the same path the app uses against the real
 * engine. Skipped when no engine URL is baked into the web build.
 */
const E2E_P2P_ENGINE_URL = process.env.E2E_P2P_ENGINE_URL || '';
const APP_URL = process.env.APP_URL || 'http://localhost:8081';
const PASSWORD = 'TestPass123!';

async function createWallet(page: Page) {
  await page.addInitScript(() => {
    try { delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker; } catch { /* ignore */ }
  });
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  await goToKeys(page);
  await page.getByText('Create New Wallet').click();
  await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
  await page.getByText('Save with Password').click();
  await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').fill(PASSWORD);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/p2p-e2e-wallet-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
}

async function newWalletPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await createWallet(page);
  return { context, page };
}

test.describe('P2P Flow', () => {
  test.skip(!E2E_P2P_ENGINE_URL, 'no P2P engine (EXPO_PUBLIC_P2P_ENGINE_URL not set)');

  test('seller lists, buyer matches, seller locks, buyer claims the transfer', async ({ browser }) => {
    test.setTimeout(180000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      // 1. Seller lists a CNY sell order (WeChat rail). USDT is the base.
      await clickTab(seller.page, 'P2P');
      await el(seller.page, 'p2p-give-token').fill('USDT');
      await el(seller.page, 'p2p-give-amount').fill('10');
      await el(seller.page, 'p2p-want-amount').fill('70');
      await el(seller.page, 'p2p-rail-wechat').click();
      await el(seller.page, 'p2p-want-currency').fill('CNY');
      await el(seller.page, 'p2p-create').click();
      await seller.page.waitForTimeout(1500);

      // 2. Seller saves a CNY collection profile (mine tab) so the buyer's
      //    payment instructions resolve.
      await el(seller.page, 'p2p-tab-mine').click();
      await el(seller.page, 'p2p-profile-method-wechat').click();
      await el(seller.page, 'p2p-profile-name').fill('Zhang San');
      await el(seller.page, 'p2p-profile-account').fill('wxid_e2e');
      await el(seller.page, 'p2p-profile-save').click();
      await seller.page.waitForTimeout(1000);

      // 3. Buyer sees it in the public book and matches.
      await clickTab(buyer.page, 'P2P');
      await expect(el(buyer.page, 'p2p-order-0')).toBeAttached({ timeout: 15000 });
      await el(buyer.page, 'p2p-buy-0').click();
      await el(buyer.page, 'p2p-buy-recv').fill('mBuyerReceiveAddressE2E');
      await el(buyer.page, 'p2p-buy-confirm').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('MATCHED', { timeout: 15000 });

      // 4. Seller locks the escrow (chain check is off in the e2e engine, so a
      //    dummy txHash is accepted).
      await el(seller.page, 'p2p-tab-mine').click();
      await el(seller.page, 'p2p-refresh').click();
      await expect(el(seller.page, 'p2p-swap-0-status')).toHaveText('MATCHED', { timeout: 15000 });
      await el(seller.page, 'p2p-swap-0-txhash').fill('ab'.repeat(32));
      await el(seller.page, 'p2p-swap-0-lock').click();
      await expect(el(seller.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });

      // 5. Buyer pulls the seller's instructions, then claims the transfer.
      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-instructions').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_PENDING', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-txid').fill('4200001234567890');
      await el(buyer.page, 'p2p-swap-0-proof').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_CLAIMED', { timeout: 15000 });
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });
});
