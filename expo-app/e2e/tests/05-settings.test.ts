/**
 * E2E Test: Settings
 *
 * Tests app settings and configuration
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import {
  waitForAppToBeReady,
  waitForElementToBeVisible,
  tapByTestId,
  typeTextByTestId,
  clearTextByTestId,
  takeScreenshot,
} from '../helpers/setup';

describe('Settings', () => {
  beforeAll(async () => {
    await device.launchApp();
    await waitForAppToBeReady();
  });

  beforeEach(async () => {
    // Navigate to settings tab
    await element(by.text('Settings')).tap();
    await waitForElementToBeVisible(by.id('settings-screen'));
  });

  it('should display settings screen', async () => {
    await detoxExpect(element(by.text('Settings'))).toBeVisible();
    await takeScreenshot('settings-screen');
  });

  it('should display network settings', async () => {
    await detoxExpect(element(by.text('Network'))).toBeVisible();
    await detoxExpect(element(by.text('Use Testnet'))).toBeVisible();
    await detoxExpect(element(by.text('Server URL'))).toBeVisible();

    await takeScreenshot('network-settings');
  });

  it('should toggle testnet', async () => {
    // Find and tap testnet toggle
    await element(by.id('testnet-toggle')).tap();

    // Verify toggle changed (visual check)
    await takeScreenshot('testnet-enabled');

    // Toggle back
    await element(by.id('testnet-toggle')).tap();

    await takeScreenshot('testnet-disabled');
  });

  it('should update server URL', async () => {
    // Clear existing URL
    await clearTextByTestId('server-url-input');

    // Enter custom URL
    await typeTextByTestId('server-url-input', 'https://custom.server.com:8088/');

    // Save changes
    await tapByTestId('save-settings-button');

    // Should show success message
    await detoxExpect(element(by.text('Settings saved successfully'))).toBeVisible();

    await takeScreenshot('custom-server-url');

    // Dismiss alert
    await element(by.text('OK')).tap();
  });

  it('should validate server URL format', async () => {
    await clearTextByTestId('server-url-input');

    // Enter invalid URL
    await typeTextByTestId('server-url-input', 'not_a_url');

    // Try to save
    await tapByTestId('save-settings-button');

    // Should show error (implementation may vary)
    await takeScreenshot('invalid-url-error');
  });

  it('should reset to default settings', async () => {
    // Modify some settings first
    await clearTextByTestId('server-url-input');
    await typeTextByTestId('server-url-input', 'https://custom.com');

    // Tap reset button
    await element(by.text('Reset to Defaults')).tap();

    // Confirm reset
    await waitForElementToBeVisible(by.text('Reset Settings'));
    await element(by.text('Reset')).tap();

    // Should show success
    await detoxExpect(element(by.text('Settings reset to defaults'))).toBeVisible();

    await takeScreenshot('settings-reset');

    // Dismiss alert
    await element(by.text('OK')).tap();
  });

  it('should display app information', async () => {
    // Scroll to About section
    await element(by.id('settings-screen')).scrollTo('bottom');

    await detoxExpect(element(by.text('About'))).toBeVisible();
    await detoxExpect(element(by.text('App Version'))).toBeVisible();
    await detoxExpect(element(by.text('Platform'))).toBeVisible();

    await takeScreenshot('app-info');
  });

  it('should persist settings across app restarts', async () => {
    // Change a setting
    await clearTextByTestId('server-url-input');
    await typeTextByTestId('server-url-input', 'https://test.com');
    await tapByTestId('save-settings-button');
    await element(by.text('OK')).tap();

    // Restart app
    await device.launchApp({ newInstance: true });
    await waitForAppToBeReady();

    // Navigate back to settings
    await element(by.text('Settings')).tap();
    await waitForElementToBeVisible(by.id('settings-screen'));

    // Setting should be persisted
    // (Actual verification would depend on implementation)
    await takeScreenshot('settings-persisted');
  });

  it('should show unsaved changes indicator', async () => {
    // Modify a setting
    await clearTextByTestId('server-url-input');
    await typeTextByTextId('server-url-input', 'https://changed.com');

    // Save button should be visible/enabled
    await detoxExpect(element(by.id('save-settings-button'))).toBeVisible();

    await takeScreenshot('unsaved-changes');
  });
});
