import { Page } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout });
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  await page.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1500);
}

export const TEST_WALLET = {
  password: 'TestPassword123!',
  privateKey: '9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891',
  address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
};
