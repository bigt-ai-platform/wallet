import { test, expect, type Page } from '@playwright/test';

/**
 * External assets over the wire — the **real** issuer service, not the mock.
 *
 * Started by `e2e/issuer-wire.sh`, which brings up Postgres, applies
 * `services/asset-issuer/schema.sql`, runs the service (`tsx src/main.ts`), and
 * seeds one holder balance so a transfer can succeed.
 *
 * This is the test the mock cannot give us: the wallet talks to the actual
 * Fastify routes, the actual Postgres-backed store and the actual asset config
 * (including the funding rails).
 *
 *   ISSUER_URL=http://127.0.0.1:18092 npx playwright test \
 *     --config e2e/playwright.config.ts external-asset-wire.spec.ts
 */

const ISSUER_URL = process.env.ISSUER_URL ?? '';

const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';

/** Plain (unlocked) wallet pointed at the live issuer. */
async function inject(page: Page, apiUrl: string) {
  await page.addInitScript(
    ([key, pub, address, url]) => {
      localStorage.setItem(
        'device.walletEncryptedContent',
        JSON.stringify({ keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }] }),
      );
      localStorage.setItem('device.walletAddress', address);
      const settings = JSON.stringify({ apiUrl: url, token: 'wire', accountId: address });
      localStorage.setItem('external.distributor', settings);
      localStorage.setItem('device.external.distributor', settings);
    },
    [EC_KEY, EC_PUB, ADDRESS, apiUrl] as const,
  );
}

async function gotoExternalAssets(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'External assets', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByTestId('ext-screen')).toBeAttached({ timeout: 15000 });
}

test.describe('external assets over the wire', () => {
  test.skip(!ISSUER_URL, 'ISSUER_URL not set — run e2e/issuer-wire.sh');

  test('serves balances, rails and accepts a transfer', async ({ page }) => {
    await inject(page, ISSUER_URL);
    await page.goto('/');
    await gotoExternalAssets(page);

    // 1000.000000 HKD seeded by the harness, rendered from the real query.
    await expect(page.getByTestId('ext-balance-hkd')).toContainText('1,000', { timeout: 15000 });

    // Rails come from the service config, not the bundle.
    await expect(page.getByTestId('ext-deposit')).toContainText('Bank transfer');
    await expect(page.getByTestId('ext-deposit-ref')).toContainText('HKD-');

    await page.getByTestId('ext-to').fill('wire-recipient');
    await page.getByTestId('ext-amount').fill('1.5');
    await page.getByTestId('ext-submit').click();

    await expect(page.getByText(/Request submitted/i)).toBeVisible();
    // The real store persisted one operation and the statement was re-read.
    await expect(page.locator('[data-testid^="ext-row-"]')).toHaveCount(1);
    // The transfer debited the seeded balance.
    await expect(page.getByTestId('ext-balance-hkd')).toContainText('998.5');
  });

  test('serves a solvency-clean health endpoint', async ({ request }) => {
    const res = await request.get(`${ISSUER_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { ok: boolean; breaches: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.breaches).toEqual([]);
  });
});
