import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1P_URL = process.env.E2E_L1P_URL || '';
const HAS_INFRA = !!E2E_SERVER_URL && !!E2E_L1P_URL;

/**
 * Predict tab (docs/prediction-market.md, phase 3). The DOM tests always run;
 * the market-flow test needs the prediction-chain infra (e2e/infra.sh brings up
 * L0 + L1-order + L1-prediction) and is skipped otherwise.
 */
test.describe('Predict Screen', () => {
  test('predict screen is reachable through the sidebar', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    const screen = await getElement(page, 'predict-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows the create-market action', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await expect(page.getByTestId('predict-create')).toBeAttached({ timeout: 10000 });
  });

  test('opens the create-market form', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Predict');
    await page.getByTestId('predict-create').click();
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-create-submit')).toBeVisible({ timeout: 5000 });
  });

  test('lists prediction markets from the prediction chain', async ({ page }) => {
    test.skip(!HAS_INFRA, 'requires E2E_SERVER_URL and E2E_L1P_URL (prediction infra)');
    await waitForApp(page);
    await clickTab(page, 'Predict');
    const screen = await getElement(page, 'predict-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
    // The list either shows at least one market card or the empty state; a
    // request error would leave a spinner forever, which this guards against.
    await expect(
      page.locator('[data-testid^="predict-event-"]').first().or(
        page.getByText('No prediction markets yet'),
      ),
    ).toBeVisible({ timeout: 30000 });
  });
});
