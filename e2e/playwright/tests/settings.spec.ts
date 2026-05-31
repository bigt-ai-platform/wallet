import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Settings Screen', () => {
  test('settings screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    const screen = await getElement(page, 'settings-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows testnet toggle', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    const toggle = await getElement(page, 'testnet-toggle');
    await expect(toggle).toBeAttached({ timeout: 10000 });
  });

  test('shows server URL input', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    const input = await getElement(page, 'server-url-input');
    await expect(input).toBeAttached({ timeout: 10000 });
  });

  test('shows app version information', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await expect(page.getByText('1.0.0').first()).toBeAttached({ timeout: 10000 });
  });

  test('shows reset to defaults button', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await expect(page.getByText('Reset to Defaults').first()).toBeAttached({ timeout: 10000 });
  });
});
