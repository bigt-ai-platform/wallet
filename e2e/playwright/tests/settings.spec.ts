import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab, disableAutoDiscover } from '../helpers';

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
    await disableAutoDiscover(page);
    const input = await getElement(page, 'server-url-input');
    await expect(input).toBeAttached({ timeout: 10000 });
  });

  test('shows app version information', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await expect(page.getByText('App Version').first()).toBeAttached({ timeout: 10000 });
  });

  test('updates card is Android-app only (hidden on web)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    // The installed version + OTA check live in the native Updater plugin, which
    // only exists in the Android (Capacitor) shell — not in a plain browser.
    await expect(page.locator('[data-testid="settings-updates-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-check-update"]')).toHaveCount(0);
  });

  test('saves the server URL and persists it to storage', async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await disableAutoDiscover(page);

    const input = page.locator('[data-testid="server-url-input"]');
    await input.fill('');
    await input.fill('http://127.0.0.1:24089/');
    await page.getByText('Save').first().click();
    await page.waitForTimeout(1000);

    // The saved URL must round-trip into the app's settings storage. The web
    // build uses the plain localStorage key; native MMKV namespaces it.
    const saved = await page.evaluate(
      () =>
        localStorage.getItem('settings.serverUrl') ??
        localStorage.getItem('mmkv.default\\settings.serverUrl'),
    );
    expect(saved).toBe('http://127.0.0.1:24089/');
  });
});
