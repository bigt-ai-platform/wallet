import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Tokens Screen', () => {
  test('tokens screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const screen = await getElement(page, 'tokens-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows search input', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const searchInput = await getElement(page, 'tokens-search-input');
    await expect(searchInput).toBeAttached({ timeout: 10000 });
  });

  test('shows token scroll view', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const scrollView = await getElement(page, 'tokens-scroll-view');
    await expect(scrollView).toBeAttached({ timeout: 10000 });
  });
});
