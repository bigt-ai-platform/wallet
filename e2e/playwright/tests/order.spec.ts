import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

test.describe('Order Screen', () => {
  test('order screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    const screen = await getElement(page, 'order-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows order tabs (Order and My Orders)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    await expect(page.getByText('Order').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('My Orders').first()).toBeAttached({ timeout: 5000 });
  });

  test('shows My Orders tab content', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    await page.getByText('My Orders').click();
    await expect(page.getByText('Your Orders')).toBeAttached({ timeout: 5000 });
  });
});
