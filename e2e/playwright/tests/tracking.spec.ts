import { test, expect, Page } from '@playwright/test';
import { waitForApp, clickTab, getElement, goToKeys, goToPayment, fundFromGenesisWallet } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

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
  const { PQKey } = await import('../../../packages/bigtangle-ts/dist/index.js');
  const key = PQKey.createNew();
  const privHex = key.getPrivateKeyHex();

  await goToKeys(page);
  await importKey(page, privHex);
  await saveWallet(page, PASSWORD);
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

/**
 * A real CONFIRMED transaction on the L0 test chain. Since the chain is
 * recreated on every run, fund a fresh wallet, submit a real BIG payment, and
 * wait for it to be confirmed. The L0 `transactionstatus` table keys records
 * by the address of the transaction's first output (the recipient), so the
 * recipient address is used to look the confirmed hash up. Used to verify the
 * Payment Tracking tab pulls a live status from the L0 `getTransactionStatus`
 * endpoint.
 */
async function getConfirmedTxHash(): Promise<string> {
  const { PQKey, Wallet, TestParams, Utils, Address, NetworkParameters } = await import('../../../packages/bigtangle-ts/dist/index.js');
  const key = PQKey.createNew();
  const wallet = Wallet.fromKeysURL(TestParams.get(), [key], E2E_SERVER_URL);
  // Fund the wallet with real on-chain BC from the genesis wallet (the Java
  // server removed the fundAddresses faucet — bootstrap is via genesis CSV).
  await fundFromGenesisWallet(E2E_SERVER_URL, [key], BigInt(10000000000));

  let funded = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const candidates = await wallet.calculateAllSpendCandidates(null, false);
    if (candidates.some(
      (c) => c.getUTXO().getTokenId() === 'bc' && c.getUTXO().isConfirmed(),
    )) {
      funded = true;
      break;
    }
  }
  if (!funded) {
    throw new Error('Funding did not confirm for test wallet');
  }

  const recipient = PQKey.createNew();
  const recipientAddr = Address.fromKey(TestParams.get(), recipient).toBase58();
  const giveMoney = new Map<string, bigint>();
  giveMoney.set(recipientAddr, 100000000n);
  await wallet.payToList(null, giveMoney, Buffer.from(Utils.HEX.decode(NetworkParameters.BIGTANGLE_TOKENID_STRING)), 'track-test');

  // Wait-check the transaction status until the payment is CONFIRMED on L0.
  let confirmedTxHash: string | null = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(E2E_SERVER_URL + 'getTransactionsStatusByAddress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: recipientAddr }),
    });
    const data = await res.json();
    const tx = (data.transactions || []).find((t: any) => t.status === 'CONFIRMED');
    if (tx) {
      confirmedTxHash = tx.txHash;
      break;
    }
  }
  if (!confirmedTxHash) {
    throw new Error('No confirmed transaction found for funded address');
  }

  // Cross-check the single-transaction status endpoint agrees.
  const single = await fetch(E2E_SERVER_URL + 'getTransactionStatus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: confirmedTxHash }),
  }).then((r) => r.json());
  expect(single.status).toBe('CONFIRMED');
  return confirmedTxHash;
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
    await goToPayment(page);
    await page.getByText('Payments', { exact: true }).click();
    await expect(await getElement(page, 'payments-tab')).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('Payment Tracking')).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('No Payments Yet')).toBeAttached({ timeout: 5000 });
  });

  test('tracked payment renders and live status comes from L0 getTransactionStatus', async ({ page }) => {
    test.setTimeout(360000);
    const confirmedTxHash = await getConfirmedTxHash();
    await seedTracking(page, [paymentRecord(confirmedTxHash)]);

    await goToPayment(page);
    await page.getByText('Payments', { exact: true }).click();

    // The recorded payment appears with a pending status initially.
    await expect(await getElement(page, 'payments-tab')).toBeAttached({ timeout: 10000 });
    const status = (await getElement(page, 'payment-status')).first();
    await expect(status).toBeAttached({ timeout: 10000 });
    await expect((await getElement(page, 'payment-txhash')).first()).toContainText(confirmedTxHash.slice(0, 16), { timeout: 5000 });

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
    await expect(page.getByText('Live on')).toBeAttached({ timeout: 5000 });
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
