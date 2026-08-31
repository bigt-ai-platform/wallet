import { test, expect } from '@playwright/test';
import { waitForApp } from '../helpers';

test.describe('Desktop layout', () => {
  test('persistent sidebar renders and bottom tab bar is hidden', async ({ page }) => {
    await waitForApp(page);

    // Persistent sidebar is docked on the left with navigation sections.
    // (Section titles are rendered via CSS uppercase, so match the DOM text.)
    await expect(page.getByText('bigT', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Home', { exact: true })).toBeVisible();
    await expect(page.getByText('Trade', { exact: true })).toBeVisible();
    await expect(page.getByText('Keys', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Payment', { exact: true }).first()).toBeVisible();

    // No bottom tab bar on desktop — navigation comes from the sidebar.
    // Playwright filters display:none elements out of role queries.
    const tabs = page.getByRole('tab');
    expect(await tabs.count()).toBe(0);
  });

  test('sidebar navigates to each destination', async ({ page }) => {
    await waitForApp(page);

    await page.getByText('Keys', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/home/keys');

    await page.getByText('Tokens', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/tokens');

    await page.getByText('Balance', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/balance');

    await page.getByText('Settings', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/settings');
  });
});
