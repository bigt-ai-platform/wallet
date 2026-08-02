import { test, expect, Page } from '@playwright/test';
import { waitForApp, clickTab, getElement } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

// A real CONFIRMED transaction on the L0 test chain (queried from the
// `transactionstatus` table). Used to verify the Payment Tracking tab pulls a
// live status from the L0 `getTransactionStatus` endpoint.
const CONFIRMED_TXHASH = '277410a3cc26fc2488a7d6b805cb2cc8ef20ea5e1587451fdf80897fae73aa27';

// MMKV web stores every key under `mmkv.default\` in localStorage.
const TRACKING_KEY = 'mmkv.default\\tracking.records';

async function importKey(page: Page, privKeyHex: string) {
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privKeyHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
}

async function saveWallet(page: Page, password: string) {
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs('/dev/null');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

async function setupUnlockedWallet(page: Page) {
  const { PQKey } = await import('/home/jcui/git/bapp/packages/bigtangle-ts/dist/index.js');
  const key = PQKey.createNew();
  const privHex = key.getPrivateKeyHex();

  await clickTab(page, 'Wallet');
  const manageBtn = page.getByText('Manage Wallet');
  if (await manageBtn.isVisible().catch(() => false)) {
    await manageBtn.click();
    await page.waitForURL('**/wallet/keys**', { timeout: 10000 });
    await importKey(page, privHex);
    await saveWallet(page, PASSWORD);
  }
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const unlockPwd = page.getByPlaceholder('Enter wallet password');
  if (await unlockPwd.isVisible().catch(() => false)) {
    await unlockPwd.fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);
  }
  return { address: key.toAddressHex(), privHex };
}

async function seedTracking(page: Page, records: any[]) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [TRACKING_KEY, JSON.stringify(records)]);
}

/**
 * Point the app at the local L0/L1 servers by writing the settings storage
 * directly. The `configureServerUrl` UI helper is unreliable here because the
 * server-URL input and the L1-chain URL inputs share the same placeholder.
 */
async function configureUrlsDirect(page: Page, serverUrl: string, l1Url: string) {
  await page.evaluate(
    ([sUrl, chains]) => {
      localStorage.setItem('mmkv.default\\settings.serverUrl', sUrl);
      localStorage.setItem('mmkv.default\\settings.l1Chains', chains);
    },
    [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])]
  );
}

/**
 * The dockerized L0/L1 servers do not send CORS headers, so the browser
 * blocks cross-origin API responses. Intercept responses to the local
 * servers and inject the CORS headers the browser requires (and answer
 * OPTIONS preflights). This is standard e2e practice for headless browsers.
 */
async function enableCors(page: Page, serverUrl: string, l1Url: string) {
  const origins = [serverUrl, l1Url]
    .filter(Boolean)
    .map((u) => u.replace(/\/+$/, ''));
  if (origins.length === 0) return;
  const pattern = new RegExp(`^(${origins.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  await page.route(pattern, async (route) => {
    try {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
          },
          body: '',
        });
        return;
      }
      const response = await route.fetch();
      const headers = { ...response.headers(), 'Access-Control-Allow-Origin': '*' };
      const body = await response.body();
      await route.fulfill({ status: response.status(), headers, body });
    } catch (e) {
      // The browser may abort/dispose a response (navigation, retries, or a
      // concurrent request racing through route.fetch) — let it fail quietly.
    }
  });
}

function paymentRecord(txHash: string) {
  return {
    id: 'payment_seed_' + Math.random().toString(36).slice(2, 8),
    kind: 'payment',
    txHash,
    tokenId: 'bc',
    tokenName: 'BIG',
    amount: '0.001',
    decimals: 8,
    fromAddress: '0101010000000000000000000000000000000000000000000000000000000000000000',
    toAddress: '0101011111111111111111111111111111111111111111111111111111111111111111',
    memo: '',
    status: 'pending',
    statusDetail: 'MEMPOOL',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function orderRecord(side: 'buy' | 'sell') {
  return {
    id: 'order_seed_' + Math.random().toString(36).slice(2, 8),
    kind: 'order',
    tokenId: 'bc',
    tokenName: 'BIG',
    amount: '100',
    decimals: 8,
    side,
    price: '0.5',
    baseToken: 'bc',
    fromAddress: '0101010000000000000000000000000000000000000000000000000000000000000000',
    status: 'pending',
    statusDetail: 'SUBMITTED',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test.describe('Payment Tracking', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    if (HAS_SERVER) {
      await enableCors(page, E2E_SERVER_URL, E2E_L1_URL);
      await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    }
    await setupUnlockedWallet(page);
  });

  test('Payments tab shows empty state before any tracked payment', async ({ page }) => {
    await clickTab(page, 'Transaction');
    await page.getByText('Payments', { exact: true }).click();
    await expect(await getElement(page, 'payments-tab')).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Payment Tracking')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('No Payments Yet')).toBeAttached({ timeout: 5000 });
  });

  test('tracked payment renders and live status comes from L0 getTransactionStatus', async ({ page }) => {
    await seedTracking(page, [paymentRecord(CONFIRMED_TXHASH)]);

    await clickTab(page, 'Transaction');
    await page.getByText('Payments', { exact: true }).click();

    // The recorded payment appears with a pending status initially.
    await expect(await getElement(page, 'payments-tab')).toBeAttached({ timeout: 10000 });
    const status = (await getElement(page, 'payment-status')).first();
    await expect(status).toBeAttached({ timeout: 10000 });
    await expect((await getElement(page, 'payment-txhash')).first()).toContainText(CONFIRMED_TXHASH.slice(0, 16), { timeout: 5000 });

    // Refresh pulls the live status from the L0 getTransactionStatus endpoint.
    const getStatusReq = page.waitForRequest(
      (req) => req.url().includes('getTransactionStatus') && req.method() === 'POST',
      { timeout: 15000 }
    );
    await page.getByText('Refresh').first().click();
    await getStatusReq;
    await expect(status).toHaveText('confirmed', { timeout: 15000 });
  });
});

test.describe('Order Tracking', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    if (HAS_SERVER) {
      await enableCors(page, E2E_SERVER_URL, E2E_L1_URL);
      await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    }
    await setupUnlockedWallet(page);
  });

  test('My Orders tab renders tracked and live sections', async ({ page }) => {
    await seedTracking(page, [orderRecord('buy')]);

    await clickTab(page, 'Order');
    await page.getByText('My Orders').click();
    await expect(page.getByText('Your Orders')).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Tracked (in-app)')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('Live on chain')).toBeAttached({ timeout: 5000 });
    await expect((await getElement(page, 'order-status')).first()).toHaveText('pending', { timeout: 5000 });
  });

  test('tracked order status refreshes via L1 getOrders', async ({ page }) => {
    await seedTracking(page, [orderRecord('sell')]);

    await clickTab(page, 'Order');
    await page.getByText('My Orders').click();
    await expect((await getElement(page, 'order-status')).first()).toBeAttached({ timeout: 10000 });

    // The live order book is queried on the configured L1 order server.
    const getOrdersReq = page.waitForRequest(
      (req) => req.url().includes('/getOrders') && req.method() === 'POST',
      { timeout: 15000 }
    );
    await page.getByText('Refresh').first().click();
    const req = await getOrdersReq;
    expect(req.url()).toContain(E2E_L1_URL || 'getOrders');

    // Not found in the open order book → treated as filled/confirmed.
    await expect((await getElement(page, 'order-status')).first()).toHaveText('confirmed', { timeout: 15000 });
  });
});
