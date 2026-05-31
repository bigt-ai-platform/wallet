import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Market Screen', () => {
  test('market screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    const screen = await getElement(page, 'market-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows market title text', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    await expect(page.getByText('Market Prices').first()).toBeAttached({ timeout: 10000 });
  });
});
