import { test, expect } from '@playwright/test';
import { waitForApp, getElement } from '../helpers';

test.describe('AI Chat Screen', () => {
  test('displays the AI chat screen', async ({ page }) => {
    await waitForApp(page);
    await page.goto('/aichat');
    await page.waitForLoadState('networkidle');
    const screen = await getElement(page, 'aichat-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows chat input field', async ({ page }) => {
    await waitForApp(page);
    await page.goto('/aichat');
    await page.waitForLoadState('networkidle');
    const input = await getElement(page, 'aichat-input');
    await expect(input).toBeAttached({ timeout: 10000 });
  });

  test('shows send button', async ({ page }) => {
    await waitForApp(page);
    await page.goto('/aichat');
    await page.waitForLoadState('networkidle');
    const sendButton = await getElement(page, 'aichat-send-button');
    await expect(sendButton).toBeAttached({ timeout: 10000 });
  });

  test('user can type a message', async ({ page }) => {
    await waitForApp(page);
    await page.goto('/aichat');
    await page.waitForLoadState('networkidle');
    const input = await getElement(page, 'aichat-input');
    await input.fill('What is Bigtangle?');
    await expect(input).toHaveValue('What is Bigtangle?');
  });

  test('shows messages scroll view', async ({ page }) => {
    await waitForApp(page);
    await page.goto('/aichat');
    await page.waitForLoadState('networkidle');
    const scrollView = await getElement(page, 'aichat-messages-scroll');
    await expect(scrollView).toBeAttached({ timeout: 10000 });
  });
});
