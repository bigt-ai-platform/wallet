import { test, expect, Page } from '@playwright/test';
import { waitForApp, clickTab } from '../helpers';
import { evaluationHashHex } from '../../../expo-app/sources/lib/blockinfo';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;

/**
 * Point the app at the local L0/L1 servers by writing the settings storage
 * directly (the Settings UI helper is unreliable because the server-URL and
 * L1-chain inputs share a placeholder). On web the app's storage abstraction
 * (sources/storage) reads plain dot-joined localStorage keys.
 */
async function configureUrlsDirect(page: Page, serverUrl: string, l1Url?: string) {
  await page.evaluate(
    ([sUrl, chains]) => {
      localStorage.setItem('settings.serverUrl', sUrl);
      if (chains) {
        localStorage.setItem('settings.l1Chains', chains);
      }
    },
    [serverUrl, l1Url ? JSON.stringify([{ chainId: 'ordermatch', name: 'Default', url: l1Url }]) : '']
  );
}

/** Open the app pointed at the local L0 and navigate to the Blocks screen. */
async function openBlocks(page: Page) {
  await waitForApp(page);
  await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
  // Reload so the app picks up the configured L0/L1 server URLs.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await clickTab(page, 'Blocks');
  await expect(page.getByTestId('blocks-screen')).toBeAttached({ timeout: 10000 });
}

/**
 * Latest block evaluation straight from the L0 API (the same
 * findBlockEvaluation the screen uses) — the test normalizes its raw
 * Sha256Hash object to the hex form with the app's own blockinfo helper.
 */
async function fetchLatestEvaluation(request: any, n = 10): Promise<any> {
  const resp = await request.post(`${E2E_SERVER_URL}findBlockEvaluation`, {
    data: { lastestAmount: String(n) },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect((body.evaluations || []).length).toBeGreaterThan(0);
  return body.evaluations[0];
}

/**
 * Block explorer UI tests (port of the server webapp's /public/blocks.jsf).
 *
 * Without E2E_SERVER_URL only the no-network UI structure tests run; with the
 * local L0 running the latest-blocks listing, hash search, chain dropdown and
 * the client-decoded block dump (Java block2string) are verified against real
 * on-chain data.
 */
test.describe('Blocks Screen', () => {
  test('blocks screen is in the DOM after navigating via sidebar', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Blocks');
    await expect(page.getByTestId('blocks-screen')).toBeAttached({ timeout: 10000 });
  });

  test('shows chain dropdown, hash search and latest-N filters', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Blocks');
    await expect(page.getByTestId('blocks-chain-select')).toBeAttached({ timeout: 10000 });
    await expect(page.getByTestId('blocks-hash-input')).toBeAttached();
    // Java's page defaults lastNum to "50".
    await expect(page.getByTestId('blocks-last-num')).toHaveValue('50');
    await expect(page.getByTestId('blocks-apply')).toBeAttached();
  });

  test('chain dropdown switches to the configured L1 chain (requires server)', async ({ page }) => {
    test.skip(!HAS_SERVER || !E2E_L1_URL, 'E2E_SERVER_URL / E2E_L1_URL not set');

    await openBlocks(page);

    // The chain dropdown lists the L0 node plus the configured L1 chains
    // (the web page discovers extra chains from a seeds registry — here the
    // user manages them in settings).
    await page.getByTestId('blocks-chain-select').click();
    await expect(page.getByTestId('blocks-chain-options').getByText('L0', { exact: true })).toBeVisible();
    await expect(page.getByTestId('blocks-chain-options').getByText('Default', { exact: true })).toBeVisible();

    // Select the L1 order chain and load its latest blocks.
    await page.getByTestId('blocks-chain-options').getByText('Default', { exact: true }).click();
    await expect(page.getByTestId('blocks-chain-options')).toBeHidden();
    await expect(page.getByTestId('blocks-chain-select')).toContainText('Default');
    await page.getByTestId('blocks-apply').click();

    // The L1 order chain always has blocks (genesis and later).
    const cards = page.getByTestId('blocks-card');
    await expect(cards.first()).toBeAttached({ timeout: 20000 });
  });

  test('lists the latest blocks with height and status (requires server)', async ({ page }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    await openBlocks(page);

    // findBlockEvaluation against the configured L0 — the chain always has
    // blocks (genesis, reward blocks).
    const cards = page.getByTestId('blocks-card');
    await expect(cards.first()).toBeAttached({ timeout: 20000 });
    expect(await cards.count()).toBeGreaterThan(0);

    const first = cards.first();
    // Height badge "#N".
    await expect(first.getByText(/#\d+/)).toBeAttached();
    // Confirmation state (balance.confirmYes/No) and the depth/inserted meta.
    await expect(first.getByText(/(confirmed|pending)/)).toBeAttached();
    await expect(first.getByText('Depth:')).toBeAttached();
    await expect(first.getByText('Inserted:')).toBeAttached();
  });

  test('search by block hash narrows the list to that block (requires server)', async ({ page, request }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    // Cross-check UI against the API: take the latest block's evaluation,
    // normalize its hash the way the app does, and search for it.
    const evaluation = await fetchLatestEvaluation(request);
    const expectedHash = evaluationHashHex(evaluation);
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);

    await openBlocks(page);

    await page.getByTestId('blocks-hash-input').fill(expectedHash);
    await page.getByTestId('blocks-apply').click();

    // searchBlockByBlockHashs must return exactly the requested block.
    const cards = page.getByTestId('blocks-card');
    await expect(cards.first()).toBeAttached({ timeout: 15000 });
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByText(`#${evaluation.height}`, { exact: true })).toBeAttached();
  });

  test('details shows the client-decoded block dump (requires server)', async ({ page, request }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const evaluation = await fetchLatestEvaluation(request);
    const expectedHash = evaluationHashHex(evaluation);

    await openBlocks(page);

    await page.getByTestId('blocks-hash-input').fill(expectedHash);
    await page.getByTestId('blocks-apply').click();

    const first = page.getByTestId('blocks-card').first();
    await expect(first).toBeAttached({ timeout: 15000 });
    await first.getByText('Details').click();

    // The dump is the app-side makeBlock(...).toString() of the raw block
    // hex (Java's block2string dialog). Its first line is the block's own
    // hash — so the decoded block must be the requested one.
    const dump = page.getByTestId('blocks-detail-dump');
    await expect(dump).toBeAttached({ timeout: 10000 });
    await expect(dump).toContainText(`hash: ${expectedHash}`, { timeout: 20000 });
    await expect(dump).toContainText('height:');
    await expect(dump).toContainText('blocktype:');
  });

  test('searching an unknown hash shows the empty state (requires server)', async ({ page }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    await openBlocks(page);

    await page.getByTestId('blocks-hash-input').fill('a'.repeat(64));
    await page.getByTestId('blocks-apply').click();
    await expect(
      page.getByText(/No blocks found|Failed|error/i).first()
    ).toBeAttached({ timeout: 15000 });
  });
});
