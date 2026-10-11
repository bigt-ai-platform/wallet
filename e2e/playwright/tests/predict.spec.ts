import { test, expect, Page } from '@playwright/test';
import {
  waitForApp, getElement, clickTab, createWallet, importAndUnlock, setL1ChainUrl,
  configureServerUrl,
} from '../helpers';

/**
 * Predict tab (docs/prediction-market.md).
 *
 * Three layers, each gated on what is actually available:
 *  1. DOM / behaviour — always runs (no infra): navigation, the create modal,
 *     and its validation. Uses a locally-created wallet so the unlocked-only
 *     paths (question/supply checks) are reachable without any chain.
 *  2. Prediction chain — skipped unless E2E_L1P_URL is set: the web build bakes
 *     prod defaults, so the spec retargets the `prediction` L1 chain at the
 *     local L1P and asserts the list resolves (a market card or the empty
 *     state — never an eternal spinner from a request error).
 *  3. Full lifecycle — skipped unless E2E_L1P_URL + E2E_PREDICTION_KEY are set:
 *     create a market in the UI, split collateral into YES+NO, then merge the
 *     pair back. The key must be the prediction-chain operator key (funded with
 *     BC, authorized to create domain tokens) — the same key RemotePredictionIT
 *     uses. Exposed as `./e2etest.sh predict`.
 */
const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const E2E_L1P_URL = process.env.E2E_L1P_URL || '';
const E2E_PREDICTION_KEY = process.env.E2E_PREDICTION_KEY || '';
const HAS_L1P = !!E2E_L1P_URL;
const HAS_LIFECYCLE = !!E2E_SERVER_URL && HAS_L1P && !!E2E_PREDICTION_KEY;
const PASSWORD = 'PredictE2ePass123!';

/**
 * The UI imports a *full* ML-DSA private key, but the harness is usually given
 * the chain's 32-byte seed (e.g. the prediction genesis seed 0x01 as 64 hex
 * chars). Accept either: expand a bare 64-hex seed via `PQKey.fromMLDSA`, else
 * use the value as-is.
 */
async function resolvePredictionKey(raw: string): Promise<string> {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return raw;
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(hex.substr(i * 2, 2), 16);
  return sdk.PQKey.fromMLDSA(seed).getPrivateKeyHex();
}

const el = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/** Wait for the Predict screen to settle into either a card or the empty state. */
async function waitListSettled(page: Page, ms = 30000) {
  await expect(
    page.locator('[data-testid^="predict-event-"]').first().or(el(page, 'predict-empty')),
  ).toBeVisible({ timeout: ms });
}

/** Point the app at the local L1-prediction chain and (re)open the Predict tab. */
async function pointAtL1P(page: Page) {
  const ok = await setL1ChainUrl(page, 'prediction', E2E_L1P_URL);
  expect(ok, 'no `prediction` L1 chain row in Settings').toBe(true);
  await clickTab(page, 'Predict');
}

test.describe('Predict Screen', () => {
  test('predict screen is reachable through the sidebar', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await expect(await getElement(page, 'predict-screen')).toBeAttached({ timeout: 10000 });
  });

  test('shows the create-market action', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await expect(page.getByTestId('predict-create')).toBeAttached({ timeout: 10000 });
  });

  test('opens the create-market form and cancels it', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await page.getByTestId('predict-create').click();
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-supply')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-resolution-days')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-create-submit')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('predict-create-cancel').click();
    await expect(page.getByTestId('predict-question')).toBeHidden({ timeout: 5000 });
  });

  test('submit is a no-op without an unlocked wallet (modal stays open)', async ({ page }) => {
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await page.getByTestId('predict-create').click();
    await page.getByTestId('predict-question').fill('will this work without a wallet?');
    await page.getByTestId('predict-create-submit').click();
    // needUnlock() alerts and returns — the modal must not close.
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('predict-create-cancel').click();
  });

  test('validates the question and the supply before creating', async ({ page }) => {
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    await page.goto('/', { waitUntil: 'load' });
    await createWallet(page, PASSWORD);
    await clickTab(page, 'Predict');
    await page.getByTestId('predict-create').click();

    // empty question -> rejected, modal stays
    await page.getByTestId('predict-question').fill('');
    await page.getByTestId('predict-supply').fill('1000');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });

    // supply 0 -> rejected, modal stays
    await page.getByTestId('predict-question').fill('will the validation test pass?');
    await page.getByTestId('predict-supply').fill('0');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('predict-create-cancel').click();
    await expect(page.getByTestId('predict-question')).toBeHidden({ timeout: 5000 });
  });
});

test.describe('Predict Chain', () => {
  test('lists markets from the L1-prediction chain (card or empty state)', async ({ page }) => {
    test.skip(!HAS_L1P, 'requires E2E_L1P_URL (L1-prediction infra)');
    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    await pointAtL1P(page);
    await expect(await getElement(page, 'predict-screen')).toBeAttached({ timeout: 10000 });
    await waitListSettled(page);
  });

  test('an expanded market exposes its contract actions', async ({ page }) => {
    test.skip(!HAS_L1P, 'requires E2E_L1P_URL (L1-prediction infra)');
    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    await pointAtL1P(page);
    const card = page.locator('[data-testid^="predict-event-"]').first();
    if ((await card.count()) === 0) test.skip(true, 'no prediction markets on this chain');
    await card.click();
    await expect(page.getByTestId('predict-trade')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-amount')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-split')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-merge')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-resolve-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-resolve-invalid')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-dispute-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-buy-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-sell-0')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Predict Lifecycle (real L1-prediction)', () => {
  test('create a market, split into YES+NO, then merge the pair back', async ({ page }) => {
    test.setTimeout(15 * 60 * 1000);
    test.skip(!HAS_LIFECYCLE, 'requires E2E_L1P_URL + E2E_PREDICTION_KEY (funded operator key)');

    const question = `e2e predict ${Date.now()}?`;
    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    await setL1ChainUrl(page, 'prediction', E2E_L1P_URL);
    await importAndUnlock(page, await resolvePredictionKey(E2E_PREDICTION_KEY), PASSWORD);
    await clickTab(page, 'Predict');

    // 1. create — a fresh market per run so re-runs never inherit vault state.
    await page.getByTestId('predict-create').click();
    await page.getByTestId('predict-question').fill(question);
    await page.getByTestId('predict-supply').fill('1000000');
    await page.getByTestId('predict-create-submit').click();

    // The created market must surface in the list (the token + create event land
    // on L1P; a rejected block or a missing domain multisign leaves it absent).
    const card = page.locator('[data-testid^="predict-event-"]').filter({ hasText: question });
    await expect(card).toBeVisible({ timeout: 240000 });

    // Expanding a real market exposes the full contract-action surface (the
    // standalone actions test skips on a fresh chain, so assert it here).
    await card.click();
    await expect(page.getByTestId('predict-trade')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-split')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-merge')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-resolve-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-resolve-invalid')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-dispute-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-buy-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-sell-0')).toBeVisible({ timeout: 5000 });

    // 2. split 100000 collateral -> 100000 YES + 100000 NO held by the wallet.
    await page.getByTestId('predict-amount').fill('100000');
    await page.getByTestId('predict-split').click();
    await expect(card.getByTestId('predict-position')).toContainText('100000', { timeout: 240000 });

    // 3. merge the complete set back -> collateral returns, position clears.
    await page.getByTestId('predict-amount').fill('100000');
    await page.getByTestId('predict-merge').click();
    await expect(card.getByTestId('predict-position')).toHaveCount(0, { timeout: 240000 });
  });
});
