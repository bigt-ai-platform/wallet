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
        funds: { checked: true, sufficient: true },
      };
      const orders: P2pOrder[] = [
        sell,
        { ...sell, orderId: 'other-sell', giveToken: 'BIG', sellerDid: 'did:pq:bob', wantRails: ['wechat'] },
        { ...sell, orderId: 'search-buy', type: 'limit_buy', sellerDid: 'did:pq:carol', funds: undefined },
      ];
      await page.route('**/public/orders?*', (route) => route.fulfill({ json: { orders } }));
      await page.route('**/capabilities', (route) => route.fulfill({ json: { rails: ['wechat', 'alipay'] } }));
      // E2E builds auto-approve the important-transaction gate
      // (EXPO_PUBLIC_E2E_AUTOCONFIRM), so a buy goes straight to its signed
      // match request — mock the match and the post-match swap refresh.
      await page.route('**/orders/search-sell/match', (route) => route.fulfill({
        json: { swapId: 'swap-fixture', status: 'MATCHED', escrowAddress: 'fixture-escrow' },
      }));
      await page.route('**/swaps/mine', (route) => route.fulfill({ json: { swaps: [] } }));
      await createWallet(page, 'P2pFixturePassword123');
      await clickTab(page, 'P2P');
      const search = page.getByTestId('p2p-book-search');
      const count = page.getByTestId('p2p-book-count');
      await expect(count).toHaveText('2 / 2 ads');
      await search.fill('  usdt CNY alipay alice ');
      await expect(count).toHaveText('1 / 2 ads');
      await expect(page.getByTestId('p2p-order-0-limit')).toContainText('Advertised: 25 USDT');
      await expect(page.getByTestId('p2p-order-0-funds')).toHaveText('Funds verified');
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
      // 20 USDT = 140 CNY sits inside [70, 140], but it would leave only 5 USDT
      // (35 CNY) behind — under the ad's 70 CNY minimum — so the ad cannot be
      // split that way: the buyer must leave at least minOrder or take the whole
      // remainder (see checkP2pFill in p2p-protocol).
      await fill.fill('20');
      await expect(feedback).toHaveText('Leave at least 70 CNY or take the full remainder.');
      await expect(confirm).toBeDisabled();
      // 15 USDT = 105 CNY leaves exactly 10 USDT (70 CNY) behind — allowed.
      await fill.fill('15');
      await expect(feedback).toHaveText('15 USDT for 105 CNY');
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
      // Snapshot the fill panel while the ad is still selected.
      await feedback.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`p2p-fill-${width}.png`) });
      // No confirm sheet in an e2e build (the gate auto-approves), so the click
      // posts the signed match straight away: assert the payload the engine
      // would receive, then the success notice.
      const matchRequest = page.waitForRequest((r) => r.url().includes('/orders/search-sell/match'));
      await confirm.click();
      const payload = (await matchRequest).postDataJSON();
      expect(payload.fillAmount).toBe('12.5');
      expect(payload.receiveAddress).toBe('fixture-receive-address');
      expect(payload.rail).toBe('wechat');
      await expect(page.getByTestId('p2p-notice')).toContainText('swap-fixture');
      await page.screenshot({ path: testInfo.outputPath(`p2p-fill-confirm-${width}.png`) });
      // A successful match leaves the screen on My Orders — go back to the book
      // for the search assertions below.
      await page.getByTestId('p2p-tab-open').click();
      await expect(page.getByTestId('p2p-book-search')).toBeVisible();
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

  test('flags an unfunded ad and disables its buy action', async ({ page }) => {
    test.skip(!process.env.E2E_P2P_ENGINE_URL, 'requires a P2P-enabled web build');
    const unfunded: P2pOrder = {
      orderId: 'unfunded-sell', type: 'limit_sell', sellerDid: 'did:pq:mallory',
      giveToken: 'USDT', giveAmount: '100', remainingGive: '100', giveChain: 'L0',
      wantCurrency: 'CNY', wantAmount: '700', wantRail: 'wechat', wantRails: ['wechat'],
      minOrder: '0', maxOrder: '700',
      validUntil: Math.floor(Date.now() / 1000) + 3600, status: 'ACTIVE', createdAt: 1,
      funds: { checked: true, sufficient: false },
    };
    await page.route('**/public/orders?*', (route) => route.fulfill({ json: { orders: [unfunded] } }));
    await page.route('**/capabilities', (route) => route.fulfill({ json: { rails: ['wechat'] } }));
    await createWallet(page, 'P2pFixturePassword123');
    await clickTab(page, 'P2P');
    await expect(page.getByTestId('p2p-order-0-limit')).toContainText('Advertised: 100 USDT');
    await expect(page.getByTestId('p2p-order-0-funds')).toHaveText('No funds at advertised address');
    await expect(page.getByTestId('p2p-buy-0')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('p2p-buy-fill')).toHaveCount(0);
  });

  test('phone verification reads WeChat via the payee notification and Alipay via the screen', async ({ page }) => {
    test.skip(!process.env.E2E_P2P_ENGINE_URL, 'requires a P2P-enabled web build');
    const swapFor = (did: string, swapId: string, wantRail: string, role: 'seller' | 'buyer') => ({
      swapId, seq: 3, status: 'PAYMENT_CLAIMED', eventType: 'payment_proof', wantRail, wantCurrency: 'CNY',
      giveToken: 'USDT', giveAmount: '10', wantAmount: '70',
      sellerDid: role === 'seller' ? did : 'did:pq:other', buyerDid: role === 'buyer' ? did : 'did:pq:other', at: 1,
    });
    await page.route('**/public/orders?*', (route) => route.fulfill({ json: { orders: [] } }));
    await page.route('**/capabilities', (route) => route.fulfill({ json: { rails: ['wechat', 'alipay', 'bank'] } }));
    await page.route('**/swaps/mine', (route) => {
      const did = route.request().postDataJSON().did as string;
      route.fulfill({ json: { swaps: [
        swapFor(did, 'swap-wechat-sell', 'wechat', 'seller'),
        swapFor(did, 'swap-wechat-buy', 'wechat', 'buyer'),
        swapFor(did, 'swap-alipay-buy', 'alipay', 'buyer'),
      ] } });
    });
    await page.route('**/pairings/mine', (route) => route.fulfill({ json: { pairings: [{
      pairingId: 'pr-fixture', endpoint: 'https://phone.example', deviceId: 'phone', swapId: null,
      issuedAt: 1, expiresAt: Date.now() + 86_400_000, revoked: false, tokenSet: true,
    }] } }));
    const reads: Record<string, unknown>[] = [];
    await page.route('**/device-read', (route) => {
      reads.push(route.request().postDataJSON());
      route.fulfill({ json: {
        swapId: 'x', side: 'seller', verdict: { side: 'seller', observed: 'received', evidenceKind: 'device_read' },
        check: { ok: true }, entry: { amount: '70.00' },
      } });
    });
    await createWallet(page, 'P2pVerifyPassword123');
    await clickTab(page, 'P2P');
    await page.getByTestId('p2p-tab-mine').click();

    // WeChat seller → the notification read.
    await page.getByTestId('p2p-swap-0-verify').click();
    await expect(page.getByTestId('p2p-verify-mode-hint')).toContainText('notification');
    await page.getByTestId('p2p-verify-read').click();
    await expect(page.getByTestId('p2p-verify-result')).toBeVisible();
    expect(reads.at(-1)?.via).toBe('notification');
    await page.getByTestId('p2p-verify-close').click();

    // WeChat buyer → nothing readable on the payer side.
    await page.getByTestId('p2p-swap-1-verify').click();
    await expect(page.getByTestId('p2p-verify-mode-hint')).toContainText('only the seller');
    // RN-web marks a disabled TouchableOpacity with aria-disabled only (no button role).
    await expect(page.getByTestId('p2p-verify-read')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('p2p-verify-close').click();

    // Alipay buyer → the screen read of the open transaction detail.
    await page.getByTestId('p2p-swap-2-verify').click();
    await expect(page.getByTestId('p2p-verify-mode-hint')).toContainText('transaction detail');
    await page.getByTestId('p2p-verify-read').click();
    await expect(page.getByTestId('p2p-verify-result')).toBeVisible();
    expect(reads.at(-1)?.via).toBe('screen');
    expect(reads).toHaveLength(2);
  });

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
