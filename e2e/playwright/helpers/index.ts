import { Page } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout });
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true }).click();
  await page.waitForTimeout(1500);
}

export async function configureServerUrl(page: Page, serverUrl: string, l1Url?: string) {
  await clickTab(page, 'Settings');
  const input = page.locator('[data-testid="server-url-input"]');
  await input.fill('');
  await input.fill(serverUrl);
  if (l1Url) {
    const l1Input = page.locator('[data-testid="l1-url-input"]');
    await l1Input.fill('');
    await l1Input.fill(l1Url);
  }
  await page.locator('text=Save').first().click();
  await page.waitForTimeout(1000);
}

export const TEST_WALLET = {
  password: 'TestPassword123!',
  privateKey: '9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891',
  address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
};
