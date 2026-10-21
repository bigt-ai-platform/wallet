import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab, createWallet } from '../helpers';
import type { P2pOrder } from '../../../expo-app/sources/services/p2p';

/**
 * P2P trading page (sources/screens/p2p/P2pScreen.tsx).
 *
 * The page is reachable from the sidebar (label "P2P") and either shows the
 * order book / create form (when EXPO_PUBLIC_P2P_ENGINE_URL is baked into the
 * web build) or a not-configured notice (the default e2e build, where
 * IS_DEV is false and no engine URL is set). Both are valid mounts; the smoke
 * test asserts the route renders and the edge state is handled, not a stub.
 */
test.describe('P2P Page', () => {
  for (const width of [390, 1440]) {
    test(`searches fixture ads and validates partial fills at ${width}px`, async ({ page }, testInfo) => {
      test.skip(!process.env.E2E_P2P_ENGINE_URL, 'requires a P2P-enabled web build');
      await page.setViewportSize({ width, height: 900 });
      const sell: P2pOrder = {
        orderId: 'search-sell', type: 'limit_sell', sellerDid: 'did:pq:alice',
        giveToken: 'USDT', giveAmount: '100', remainingGive: '25', giveChain: 'L0',
        wantCurrency: 'CNY', wantAmount: '700', wantRail: 'wechat', wantRails: ['wechat', 'alipay'],
        minOrder: '70', maxOrder: '140',
        validUntil: Math.floor(Date.now() / 1000) + 3600, status: 'ACTIVE', createdAt: 1,
      };
      const orders: P2pOrder[] = [
        sell,
        { ...sell, orderId: 'other-sell', giveToken: 'BIG', sellerDid: 'did:pq:bob', wantRails: ['wechat'] },
        { ...sell, orderId: 'search-buy', type: 'limit_buy', sellerDid: 'did:pq:carol' },
      ];
      await page.route('**/public/orders?*', (route) => route.fulfill({ json: { orders } }));
      await page.route('**/capabilities', (route) => route.fulfill({ json: { rails: ['wechat', 'alipay'] } }));
      await createWallet(page, 'P2pFixturePassword123');
      await clickTab(page, 'P2P');
      const search = page.getByTestId('p2p-book-search');
      const count = page.getByTestId('p2p-book-count');
      await expect(count).toHaveText('2 / 2 ads');
      await search.fill('  usdt CNY alipay alice ');
      await expect(count).toHaveText('1 / 2 ads');
      await expect(page.getByTestId('p2p-order-0-limit')).toContainText('Available: 25 USDT');
      await expect(page.getByTestId('p2p-order-1')).toHaveCount(0);
      await page.getByTestId('p2p-buy-0').click();
      await expect(page.getByTestId('p2p-buy-fill')).toHaveValue('25');
      const fill = page.getByTestId('p2p-buy-fill');
      const feedback = page.getByTestId('p2p-fill-feedback');
      const confirm = page.getByTestId('p2p-buy-confirm');
      await expect(feedback).toHaveText('Maximum trade: 140 CNY.');
      await expect(confirm).toBeDisabled();
      await fill.fill('26');
      await expect(feedback).toContainText('up to 25 USDT');
      await expect(confirm).toBeDisabled();
      await fill.fill('9');
      await expect(feedback).toHaveText('Minimum trade: 70 CNY.');
      await expect(confirm).toBeDisabled();
      await fill.fill('10');
      await expect(feedback).toHaveText('10 USDT for 70 CNY');
      await expect(confirm).toBeEnabled();
      await fill.fill('20');
      await expect(feedback).toHaveText('20 USDT for 140 CNY');
      await expect(confirm).toBeEnabled();
      for (const invalidFiat of ['0', '-1', 'abc']) {
        await page.getByTestId('p2p-buy-fill-fiat').fill(invalidFiat);
        await expect(feedback).toContainText('greater than 0 and up to 25 USDT');
        await expect(confirm).toBeDisabled();
      }
      await page.getByTestId('p2p-buy-fill-fiat').fill('87.5');
      await expect(fill).toHaveValue('12.5');
      await expect(feedback).toHaveText('12.5 USDT for 87.5 CNY');
      await page.getByTestId('p2p-buy-recv').fill('fixture-receive-address');
      await confirm.click();
      await expect(page.getByTestId('confirm-transaction')).toContainText('Buy: 12.5 USDT for 87.5 CNY');
      await page.screenshot({ path: testInfo.outputPath(`p2p-fill-confirm-${width}.png`) });
      await page.getByTestId('confirm-cancel').click();
      await expect(page.getByTestId('confirm-transaction')).not.toBeVisible();
      await feedback.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`p2p-fill-${width}.png`) });
      await search.fill('EUR');
      await expect(count).toHaveText('0 / 2 ads');
      await expect(page.getByTestId('p2p-book-empty')).toHaveText('No matches');
      await page.getByTestId('p2p-book-clear').click();
      await expect(search).toHaveValue('');
      await expect(count).toHaveText('2 / 2 ads');
      await expect(page.getByTestId('p2p-buy-fill')).toHaveCount(0);
      await page.getByTestId('p2p-tab-sell').click();
      await expect(count).toHaveText('1 / 1 ads');
      await expect(page.getByTestId('p2p-order-0-side')).toContainText('Buy');
      await search.fill('alice');
      await expect(count).toHaveText('0 / 1 ads');
      await page.getByTestId('p2p-book-clear').click();
      await page.getByTestId('p2p-order-0').scrollIntoViewIfNeeded();
      const bounds = await search.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`p2p-search-${width}.png`) });
    });
  }

  test('navigates from the sidebar and mounts the P2P screen', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'P2P');
    const mounted = page.locator('[data-testid="p2p-not-configured"], [data-testid="p2p-tab-open"]').first();
    await expect(mounted).toBeAttached({ timeout: 10000 });
  });

  test('shows the not-configured notice when no engine is baked in', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'P2P');
    const tab = await getElement(page, 'p2p-tab-open');
    // The default e2e web build has no engine URL: assert the deterministic
    // edge state. If a build with an engine is used, assert the tabs instead.
    if ((await tab.count()) > 0) {
      await expect(tab).toBeAttached();
      await expect(await getElement(page, 'p2p-create')).toBeAttached({ timeout: 10000 });
    } else {
      await expect(await getElement(page, 'p2p-not-configured')).toBeAttached({ timeout: 10000 });
    }
  });
});
