import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Market Screen', () => {
  test('market screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    const screen = await getElement(page, 'market-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows market tabs (Market and My Orders)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    await expect(page.getByText('Market').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('My Orders').first()).toBeAttached({ timeout: 5000 });
  });

  test('shows My Orders tab content', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Market');
    await page.getByText('My Orders').click();
    await expect(page.getByText('Your Orders')).toBeAttached({ timeout: 5000 });
  });
});
