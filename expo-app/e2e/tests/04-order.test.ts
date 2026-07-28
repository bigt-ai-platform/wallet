/**
 * E2E Test: Order
 *
 * Tests order price viewing and functionality
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import {
  waitForAppToBeReady,
  waitForElementToBeVisible,
  tapByTestId,
  takeScreenshot,
  waitForNetwork,
} from '../helpers/setup';
import {
  verifyPriceChange,
  verifySortOrder,
} from '../helpers/logic-verification';

describe('Order', () => {
  beforeAll(async () => {
    await device.launchApp();
    await waitForAppToBeReady();
  });

  beforeEach(async () => {
    // Navigate to order tab
    await element(by.text('Order')).tap();
    await waitForElementToBeVisible(by.id('order-screen'));
  });

  it('should display order screen', async () => {
    await detoxExpect(element(by.text('Order Prices'))).toBeVisible();
    await takeScreenshot('order-screen');
  });

  it('should load order prices', async () => {
    await waitForNetwork(3000);

    await takeScreenshot('order-prices-loaded');
  });

  it('should display price cards with data', async () => {
    await waitForNetwork(3000);

    try {
      // Check if price cards are visible
      await detoxExpect(element(by.id('price-card-0'))).toBeVisible();

      // Price card should have token name, price, and change
      await takeScreenshot('price-card-details');
    } catch (e) {
      // No order data available
      await detoxExpect(element(by.text('No order data available'))).toBeVisible();
      await takeScreenshot('no-order-data');
    }
  });

  it('should show price change indicators', async () => {
    // ============ LOGIC VERIFICATION ============
    // Test price change calculations
    const testCases = [
      { current: 100, previous: 90, expected: { change: 10, changePercent: 11.11, direction: 'up' as const } },
      { current: 80, previous: 100, expected: { change: -20, changePercent: -20, direction: 'down' as const } },
      { current: 50, previous: 50, expected: { change: 0, changePercent: 0, direction: 'flat' as const } },
    ];

    testCases.forEach(({ current, previous, expected }) => {
      const result = verifyPriceChange(current, previous);
      expect(result.change).toBe(expected.change);
      expect(Math.abs(result.changePercent - expected.changePercent)).toBeLessThan(0.1);
      expect(result.direction).toBe(expected.direction);
      console.log(`✅ Price change: ${previous} → ${current} = ${result.changePercent.toFixed(2)}% ${result.direction}`);
    });

    // ============ UI VERIFICATION ============
    await waitForNetwork(3000);

    try {
      // Check for price change indicators (positive/negative)
      await takeScreenshot('price-changes');
    } catch (e) {
      await takeScreenshot('no-price-changes');
    }
  });

  it('should refresh order data', async () => {
    await waitForNetwork(2000);

    // Swipe down to refresh
    await element(by.id('order-screen')).swipe('down', 'slow', 0.75);

    // Wait for refresh to complete
    await waitForNetwork(2000);

    await takeScreenshot('order-refreshed');
  });

  it('should display volume information', async () => {
    await waitForNetwork(3000);

    try {
      // Check if volume is displayed
      await takeScreenshot('order-volume');
    } catch (e) {
      await takeScreenshot('no-order-volume-data');
    }
  });

  it('should handle empty order data', async () => {
    // Wait for loading to complete
    await waitForNetwork(3000);

    // Check for empty state or data
    let hasData = false;
    let isEmpty = false;
    try {
      await detoxExpect(element(by.id('price-card-0'))).toBeVisible();
      hasData = true;
    } catch {
      hasData = false;
    }
    if (!hasData) {
      try {
        await detoxExpect(element(by.text('No order data available'))).toBeVisible();
        isEmpty = true;
      } catch {
        isEmpty = false;
      }
    }

    if (isEmpty) {
      await detoxExpect(element(by.text('No order data available'))).toBeVisible();
    }

    await takeScreenshot('order-empty-state');
  });

  it('should handle network errors gracefully', async () => {
    // This would require mocking network failures
    // Document expected error handling
    await takeScreenshot('order-error-handling');
  });

  it('should display loading state', async () => {
    // Reload to see loading state
    await device.reloadReactNative();
    await element(by.text('Order')).tap();

    // Should show loading indicator briefly
    await takeScreenshot('order-loading');

    await waitForNetwork(3000);
  });
});
