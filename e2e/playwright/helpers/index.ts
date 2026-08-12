import { Page } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/', { waitUntil: 'load', timeout });
  await page.waitForTimeout(3000);
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label }).click();
  await page.waitForTimeout(2000);
}

export async function configureServerUrl(page: Page, serverUrl: string, l1Url?: string) {
  await clickTab(page, 'Settings');
  const input = page.locator('[data-testid="server-url-input"]');
  await input.fill('');
  await input.fill(serverUrl);
  if (l1Url) {
    // Update the FIRST L1 chain URL input. The server-url-input also has
    // placeholder "https://...", so skip it (index 0) and use index 1.
    const urlInputs = page.locator('input[placeholder="https://..."]');
    const count = await urlInputs.count();
    if (count > 1) {
      await urlInputs.nth(1).fill('');
      await urlInputs.nth(1).fill(l1Url);
    }
  }
  await page.locator('text=Save').first().click();
  await page.waitForTimeout(1000);
}

export const TEST_WALLET = {
  password: 'TestPassword123!',
  privateKey: '9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891',
  address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
};
