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
    await expect(page.getByText('App Version').first()).toBeAttached({ timeout: 10000 });
  });

  test('shows reset to defaults button', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await expect(page.getByText('Reset to Defaults').first()).toBeAttached({ timeout: 10000 });
  });

  test('shows the updates card with a check button', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    const card = await getElement(page, 'settings-updates-card');
    await expect(card).toBeAttached({ timeout: 10000 });
    const button = await getElement(page, 'settings-check-update');
    await expect(button).toBeAttached({ timeout: 10000 });
  });

  test('update check is unavailable on the web build (no native plugin)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Settings');
    await page.locator('[data-testid="settings-check-update"]').click();
    await expect(page.getByText('Update check unavailable.')).toBeAttached({ timeout: 10000 });
  });

  test('saves the server URL and persists it to storage', async ({ page }) => {
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await waitForApp(page);
    await clickTab(page, 'Settings');

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
