/**
 * E2E Test: App Launch
 *
 * Tests basic app launch and navigation
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import { waitForAppToBeReady, waitForElementToBeVisible, takeScreenshot } from '../helpers/setup';

describe('App Launch', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('should launch app successfully', async () => {
    await waitForAppToBeReady();
    await takeScreenshot('app-launch');
  });

  it('should show tab navigation', async () => {
    await waitForAppToBeReady();

    // Check all tabs are visible
    await detoxExpect(element(by.text('Transaction'))).toBeVisible();
    await detoxExpect(element(by.text('Wallet'))).toBeVisible();
    await detoxExpect(element(by.text('Market'))).toBeVisible();
    await detoxExpect(element(by.text('Tokens'))).toBeVisible();
    await detoxExpect(element(by.text('Settings'))).toBeVisible();

    await takeScreenshot('tab-navigation');
  });

  it('should navigate between tabs', async () => {
    await waitForAppToBeReady();

    // Navigate to each tab
    await element(by.text('Wallet')).tap();
    await waitForElementToBeVisible(by.id('wallet-screen'));
    await takeScreenshot('wallet-tab');

    await element(by.text('Market')).tap();
    await waitForElementToBeVisible(by.id('market-screen'));
    await takeScreenshot('market-tab');

    await element(by.text('Tokens')).tap();
    await waitForElementToBeVisible(by.id('tokens-screen'));
    await takeScreenshot('tokens-tab');

    await element(by.text('Settings')).tap();
    await waitForElementToBeVisible(by.id('settings-screen'));
    await takeScreenshot('settings-tab');

    // Navigate back to transaction
    await element(by.text('Transaction')).tap();
    await waitForElementToBeVisible(by.id('transaction-screen'));
  });

  it('should display transaction screen by default', async () => {
    await waitForAppToBeReady();
    await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();
  });

  it('should handle app state changes', async () => {
    await waitForAppToBeReady();

    // Send app to background
    await device.sendToHome();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Bring app back to foreground
    await device.launchApp({ newInstance: false });

    // Should still show the app
    await waitForAppToBeReady();
    await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();
  });

  it('should show correct orientation', async () => {
    await waitForAppToBeReady();

    // Test portrait mode
    await device.setOrientation('portrait');
    await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

    // Test landscape mode (if supported)
    await device.setOrientation('landscape');
    await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

    // Reset to portrait
    await device.setOrientation('portrait');
  });
});
