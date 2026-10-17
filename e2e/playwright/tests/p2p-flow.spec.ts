import { test, expect, Browser, Page } from '@playwright/test';
import { clickTab, goToKeys } from '../helpers';

const el = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/**
 * P2P UI flow against a running p2p-engine (started by e2etest.sh as `p2p-ui`,
 * mem store, no chain check). Two isolated browser contexts each create a fresh
 * wallet, so the two sides have distinct PQ dids; the engine's read routes are
 * party-scoped, so each side signs with its own key — the same path the app
 * uses against the real engine. Skipped when no engine URL is baked in.
 *
 * Covered here (the UI half — route semantics + the chain legs are covered by
 * services/p2p-engine/test and the p2p-orders / p2p-demo / p2p-settlement
 * specs):
 *   - a listing shows the TOTAL fiat (wantAmount) + the implied unit price;
 *   - seller lists → buyer matches → seller locks (MATCHED → ESCROW_LOCKED);
 *   - buyer pulls the CNY instructions (profile name + account + amount) and
 *     claims the transfer (PAYMENT_PENDING → PAYMENT_CLAIMED);
 *   - seller confirms on their own statement (PAYMENT_CLAIMED → PAYMENT_VERIFIED)
 *     and the engine-signed release becomes reachable;
 *   - seller cancels an ACTIVE order → it leaves the book;
 *   - instructions fail loudly when the seller saved no profile for the rail.
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

/** Seller lists a CNY (WeChat) sell order (create switches to the mine tab). */
async function listOrder(page: Page, giveAmount: string, wantAmount: string) {
  await clickTab(page, 'P2P');
  await el(page, 'p2p-give-token').fill('USDT');
  await el(page, 'p2p-give-amount').fill(giveAmount);
  await el(page, 'p2p-want-amount').fill(wantAmount);
  await el(page, 'p2p-rail-wechat').click();
  await el(page, 'p2p-want-currency').fill('CNY');
  await el(page, 'p2p-create').click();
  await page.waitForTimeout(1500);
}

async function saveWechatProfile(page: Page, name: string, account: string) {
  await el(page, 'p2p-tab-mine').click();
  await el(page, 'p2p-profile-method-wechat').click();
  await el(page, 'p2p-profile-name').fill(name);
  await el(page, 'p2p-profile-account').fill(account);
  await el(page, 'p2p-profile-save').click();
  await page.waitForTimeout(1000);
}

async function matchOrder(page: Page) {
  await clickTab(page, 'P2P');
  await expect(el(page, 'p2p-order-0')).toBeAttached({ timeout: 15000 });
  await el(page, 'p2p-buy-0').click();
  await el(page, 'p2p-buy-recv').fill('mBuyerReceiveAddressE2E');
  await el(page, 'p2p-buy-confirm').click();
  // submitBuy switches to the mine tab, where the swap card lives.
  await expect(el(page, 'p2p-swap-0-status')).toHaveText('MATCHED', { timeout: 15000 });
}

async function lockEscrow(page: Page) {
  await el(page, 'p2p-tab-mine').click();
  await el(page, 'p2p-refresh').click();
  await expect(el(page, 'p2p-swap-0-status')).toHaveText('MATCHED', { timeout: 15000 });
  await el(page, 'p2p-swap-0-txhash').fill('ab'.repeat(32));
  await el(page, 'p2p-swap-0-lock').click();
  await expect(el(page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
}

test.describe('P2P Flow', () => {
  test.skip(!E2E_P2P_ENGINE_URL, 'no P2P engine (EXPO_PUBLIC_P2P_ENGINE_URL not set)');

  test('full CNY lifecycle: total, instructions, claim, confirm', async ({ browser }) => {
    test.setTimeout(180000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      // 1. Seller lists a CNY sell order (WeChat rail). USDT is the base.
      await listOrder(seller.page, '10', '70');

      // 2. Seller saves a CNY collection profile (mine tab) so the buyer's
      //    payment instructions resolve.
      await saveWechatProfile(seller.page, 'Zhang San', 'wxid_e2e');

      // 3. Buyer sees it in the public book: the card shows the TOTAL fiat
      //    (wantAmount) and the implied per-unit price (total / amount).
      await clickTab(buyer.page, 'P2P');
      await expect(el(buyer.page, 'p2p-order-0')).toBeAttached({ timeout: 15000 });
      await expect(el(buyer.page, 'p2p-order-0-total')).toContainText('70');
      await expect(el(buyer.page, 'p2p-order-0-unit')).toContainText('7');

      // 4. Buyer matches.
      await el(buyer.page, 'p2p-buy-0').click();
      await el(buyer.page, 'p2p-buy-recv').fill('mBuyerReceiveAddressE2E');
      await el(buyer.page, 'p2p-buy-confirm').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('MATCHED', { timeout: 15000 });

      // 5. Seller locks the escrow (chain check is off in the e2e engine, so a
      //    dummy txHash is accepted).
      await lockEscrow(seller.page);

      // 6. Buyer pulls the seller's instructions: the panel carries the profile
      //    (name + account) and the exact amount to transfer.
      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-instructions').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_PENDING', { timeout: 15000 });
      const panel = el(buyer.page, 'p2p-swap-0-instructions-panel');
      await expect(panel).toContainText('Zhang San');
      await expect(panel).toContainText('wxid_e2e');
      await expect(panel).toContainText('70');

      // 7. Buyer claims the transfer (流水号) → PAYMENT_CLAIMED.
      await el(buyer.page, 'p2p-swap-0-txid').fill('4200001234567890');
      await el(buyer.page, 'p2p-swap-0-proof').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_CLAIMED', { timeout: 15000 });

      // 8. Seller confirms on their own statement → PAYMENT_VERIFIED, and the
      //    engine-signed release becomes reachable.
      await el(seller.page, 'p2p-refresh').click();
      await expect(el(seller.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_CLAIMED', { timeout: 15000 });
      await el(seller.page, 'p2p-swap-0-confirm').click();
      await expect(el(seller.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_VERIFIED', { timeout: 15000 });
      await expect(el(seller.page, 'p2p-swap-0-release')).toBeAttached();
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });

  test('seller cancels an ACTIVE order and it leaves the book', async ({ browser }) => {
    test.setTimeout(120000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      await listOrder(seller.page, '5', '35');
      // The seller is on the mine tab after create; the cancel control is on the
      // open-book card.
      await el(seller.page, 'p2p-tab-open').click();
      await el(seller.page, 'p2p-refresh').click();
      await expect(el(seller.page, 'p2p-order-0')).toBeAttached({ timeout: 15000 });

      await clickTab(buyer.page, 'P2P');
      await expect(el(buyer.page, 'p2p-order-0')).toBeAttached({ timeout: 15000 });

      await el(seller.page, 'p2p-cancel-order-0').click();
      await seller.page.waitForTimeout(1500);
      await el(seller.page, 'p2p-refresh').click();
      await expect(el(seller.page, 'p2p-order-0')).toHaveCount(0, { timeout: 15000 });

      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-order-0')).toHaveCount(0, { timeout: 15000 });
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });

  test('instructions fail loudly when the seller has no profile for the rail', async ({ browser }) => {
    test.setTimeout(150000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      // No profile is saved — the seller never configured the WeChat rail.
      await listOrder(seller.page, '10', '70');
      await matchOrder(buyer.page);
      await lockEscrow(seller.page);

      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-instructions').click();

      // The engine answers 409 "seller has no payment profile for this rail";
      // the wallet surfaces it and the swap must not advance.
      await expect(el(buyer.page, 'p2p-notice')).toContainText('profile', { timeout: 15000 });
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED');
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });

  test('seller expires a locked, unpaid swap (buyer no-show)', async ({ browser }) => {
    test.setTimeout(150000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      await listOrder(seller.page, '10', '70');
      await matchOrder(buyer.page);
      await lockEscrow(seller.page);

      // The buyer never pays; the seller unwinds it. EXPIRED settles through
      // the refund action (ESCROW_REFUNDED).
      await el(seller.page, 'p2p-swap-0-expire').click();
      await expect(el(seller.page, 'p2p-swap-0-status')).toHaveText('EXPIRED', { timeout: 15000 });
      await expect(el(seller.page, 'p2p-swap-0-refund')).toBeAttached();

      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('EXPIRED', { timeout: 15000 });
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });

  test('buyer cancels before paying (never sent fiat)', async ({ browser }) => {
    test.setTimeout(150000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      await listOrder(seller.page, '10', '70');
      await matchOrder(buyer.page);
      await lockEscrow(seller.page);

      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-cancel').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('CANCELLED', { timeout: 15000 });
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });

  test('buyer disputes after claiming — the swap freezes', async ({ browser }) => {
    test.setTimeout(180000);

    const seller = await newWalletPage(browser);
    const buyer = await newWalletPage(browser);

    try {
      await listOrder(seller.page, '10', '70');
      await saveWechatProfile(seller.page, 'Zhang San', 'wxid_e2e');
      await matchOrder(buyer.page);
      await lockEscrow(seller.page);

      // Claim a payment (PAYMENT_PENDING → PAYMENT_CLAIMED), then dispute it:
      // an open dispute freezes the swap (nothing advances or unwinds).
      await el(buyer.page, 'p2p-refresh').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('ESCROW_LOCKED', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-instructions').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_PENDING', { timeout: 15000 });
      await el(buyer.page, 'p2p-swap-0-txid').fill('4200001234567890');
      await el(buyer.page, 'p2p-swap-0-proof').click();
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_CLAIMED', { timeout: 15000 });

      await el(buyer.page, 'p2p-swap-0-dispute').click();
      await expect(el(buyer.page, 'p2p-swap-0')).toContainText('OPEN', { timeout: 15000 });
      // Frozen: the swap did not advance past the claim.
      await expect(el(buyer.page, 'p2p-swap-0-status')).toHaveText('PAYMENT_CLAIMED');
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });
});
