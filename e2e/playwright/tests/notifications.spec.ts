import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from '../helpers';

const TRACKING_KEY = 'tracking.records';

async function seedTracking(page: Page, records: unknown[]) {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TRACKING_KEY, JSON.stringify(records)],
  );
}

test.describe('System notifications', () => {
  test('payment reaching finality raises a page message', async ({ page }) => {
    const txHash = 'a'.repeat(64);
    await page.route('**/getTransactionStatus', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ txHash, status: 'CONFIRMED' }),
    }));
    await seedTracking(page, [{
      id: 'payment_e2e_finality',
      kind: 'payment',
      txHash,
      tokenId: 'bc',
      tokenName: 'BIG',
      amount: '1',
      decimals: 6,
      fromAddress: 'from',
      toAddress: 'to',
      layer: 0,
      status: 'pending',
      statusDetail: 'MEMPOOL',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);

    await waitForApp(page);

    await expect(page.getByTestId('system-message-title')).toHaveText('Payment finalized', { timeout: 20000 });
    await expect(page.getByTestId('system-message-body')).toContainText('reached chain finality');
    await expect(page.getByTestId('system-message-dismiss')).toBeVisible();

    // The same event remains in the persisted centre and carries unread state.
    await expect(page.getByTestId('home-notifications')).toBeVisible();
    await expect(page.getByTestId('home-notifications-unread')).toHaveText('1');
    await page.getByTestId('home-notifications-view-all').click();
    await expect(page.getByTestId('notifications-screen')).toBeVisible();
    const rows = page.locator('[data-testid^="notification-row-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.getByText('Payment finalized')).toBeVisible();
  });

  test('filled trade order raises a page message', async ({ page }) => {
    await page.route('**/getOrders', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ allOrdersSorted: [], tokennames: {} }),
    }));
    await seedTracking(page, [{
      id: 'order_e2e_filled',
      kind: 'order',
      txHash: 'b'.repeat(64),
      tokenId: 'nvidia',
      tokenName: 'Nvidia',
      amount: '1',
      decimals: 6,
      side: 'buy',
      price: '234.75',
      baseToken: 'usdt',
      fromAddress: '14UT6fej3qCAN26hhYEdJuDGZNFwyTHP3N',
      status: 'pending',
      statusDetail: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);

    await waitForApp(page);

    await expect(page.getByTestId('system-message-title')).toHaveText('Order filled', { timeout: 20000 });
    await expect(page.getByTestId('system-message-body')).toContainText('matched on-chain');
  });
});
