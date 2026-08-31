import { Page } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/', { waitUntil: 'load', timeout });
  await page.waitForTimeout(3000);
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  // The bottom tab bar is only visible on tab screens, and several screens are
  // no longer tabs at all — so navigate through the sidebar, which works on
  // both mobile (drawer) and desktop (persistent) and preserves in-memory
  // state (e.g. an unlocked wallet).
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

// The Payment (send) and Keys (wallet management) screens are no longer tabs —
// they live at their own routes reachable through the sidebar. Navigate
// directly to keep the tests independent of the sidebar/tab-bar layout.
export async function goToPayment(page: Page) {
  await page.goto('/home/payment', { waitUntil: 'load' });
  await page.waitForTimeout(2000);
}

export async function goToKeys(page: Page) {
  await page.goto('/home/keys', { waitUntil: 'load' });
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
