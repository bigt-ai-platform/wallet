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

async function configurePredictionChain(page: Page, url: string) {
  let ok = await setL1ChainUrl(page, 'prediction', url);
  if (!ok) {
    const fields = page.getByTestId('new-chain-id-input').locator('..');
    await page.getByTestId('new-chain-id-input').fill('prediction');
    await fields.locator('input').nth(1).fill('Prediction');
    await fields.locator('input[placeholder="https://..."]').fill(url);
    await fields.getByText('+', { exact: true }).click();
    ok = await setL1ChainUrl(page, 'prediction', url);
  }
  expect(ok, 'no `prediction` L1 chain row in Settings').toBe(true);
}

/** Point the app at the local L1-prediction chain and (re)open the Predict tab. */
async function pointAtL1P(page: Page) {
  await configurePredictionChain(page, E2E_L1P_URL);
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
    await expect(page.getByTestId('predict-create-error')).toContainText('question');

    // supply 0 -> rejected, modal stays
    await page.getByTestId('predict-question').fill('will the validation test pass?');
    await page.getByTestId('predict-supply').fill('0');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-question')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('predict-create-error')).toContainText('supply');

    await page.getByTestId('predict-supply').fill('invalid');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-create-error')).toContainText('Supply');
    await page.getByTestId('predict-supply').fill('1000');
    await page.getByTestId('predict-outcomes').fill('Home\nHome');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-create-error')).toContainText('unique');
    await page.getByTestId('predict-outcomes').fill('Home\nDraw\nAway');
    await page.getByTestId('predict-oracle-committee').click();
    await page.getByTestId('predict-committee').fill('aa');
    await page.getByTestId('predict-create-submit').click();
    await expect(page.getByTestId('predict-create-error')).toContainText('two distinct');

    await page.getByTestId('predict-create-cancel').click();
    await expect(page.getByTestId('predict-question')).toBeHidden({ timeout: 5000 });
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    test(`guards actions and previews partial liquidity at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const values = { classname: 'net.bigtangle.server.service.PredictionContract', S: '1000',
        outcomeTokenids: 'yes-token,no-token', outcomeNames: 'Home,Away', collateralTokenid: 'bc',
        question: 'Will the home team win?', oracle: 'staked', proposalBond: '10', disputeBond: '10',
        resolutionTimeSec: String(Math.floor(Date.now() / 1000) + 3600), disputeWindowSec: '300', autoInvalidSec: '600' };
      const token = { tokenid: 'market', tokenKeyValues: { keyvalues: Object.entries(values).map(([key, value]) => ({ key, value })) } };
      let status = 'OPEN';
      let unavailable = false;
      await page.route('**/searchContractTokens', (route) => route.fulfill({ json: { tokens: [token] } }));
      await page.route('**/getBalances', (route) => route.fulfill({ json: { outputs: [], balances: [], tokennames: [] } }));
      await page.route('**/getPredictionState', (route) => route.fulfill({ json: unavailable
        ? { contractTokenid: 'market', confirmed: false, state: null }
        : { contractTokenid: 'market', confirmed: true, blockHash: 'ab'.repeat(32),
          state: { initialized: true, status, outcome: status === 'FINAL' ? 'yes-token' : null, vaultStock: {}, vaultCollateral: '0' } } }));
      await page.route('**/getOrders', (route) => route.fulfill({ json: { orders: [
        { side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'bc', price: '50', offerValue: '30' },
        { side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'bc', price: '60', offerValue: '20' },
      ] } }));
      await page.goto('/', { waitUntil: 'load' });
      await createWallet(page, PASSWORD);
      await configurePredictionChain(page, 'http://127.0.0.1:24088/');
      await clickTab(page, 'Predict');
      const card = page.getByTestId('predict-event-market');
      await expect(card.getByTestId('predict-status')).toHaveText('Open');
      await card.click();
      await expect(page.getByTestId('predict-resolve-0')).toBeDisabled();
      await expect(page.getByTestId('predict-dispute-0')).toBeDisabled();
      await expect(page.getByTestId('predict-vote-0')).toBeDisabled();
      await page.getByTestId('predict-amount').fill('80');
      await page.getByTestId('predict-buy-0').click();
      await expect(page.getByTestId('predict-quote-fill')).toContainText('50 / 80');
      await expect(page.getByTestId('predict-price-limit')).toContainText('60');
      await page.getByTestId('predict-slippage').fill('11');
      await expect(page.getByTestId('predict-quote-submit')).toBeDisabled();
      await page.getByTestId('predict-slippage').fill('1');
      await expect(page.getByTestId('predict-quote-submit')).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`prediction-preview-${viewport.width}.png`), fullPage: true });
      await page.getByTestId('predict-quote-cancel').click();
      unavailable = true;
      await page.getByTestId('predict-refresh').click();
      await expect(card.getByTestId('predict-status')).toContainText('unavailable');
      await expect(page.getByTestId('predict-split')).toBeDisabled();
      await expect(page.getByTestId('predict-buy-0')).toBeDisabled();
      unavailable = false;
      status = 'FINAL';
      await page.getByTestId('predict-refresh').click();
      await expect(card.getByTestId('predict-status')).toHaveText('Final: Home');
      await expect(page.getByTestId('predict-merge')).toBeDisabled();
      await expect(page.getByTestId('predict-sell-0')).toBeDisabled();
      await page.getByTestId('predict-create').click();
      await page.getByTestId('predict-outcomes').fill('Home\nDraw\nAway');
      await page.screenshot({ path: testInfo.outputPath(`prediction-create-${viewport.width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByTestId('predict-create-cancel').click();
    });
  }
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
    await createWallet(page, PASSWORD);
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
  test('create, split, merge, trade, resolve and redeem a market', async ({ page }) => {
    test.setTimeout(25 * 60 * 1000);
    test.skip(!HAS_LIFECYCLE, 'requires E2E_L1P_URL + E2E_PREDICTION_KEY (funded operator key)');

    const question = `e2e predict ${Date.now()}?`;
    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
    const privateKey = await resolvePredictionKey(E2E_PREDICTION_KEY);
    const operator = sdk.PQKey.fromPrivateKey(new Uint8Array(sdk.Utils.HEX.decode(privateKey)));
    const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [operator], E2E_L1P_URL);
    const post = async (endpoint: string, body: unknown) => {
      const response = await fetch(`${E2E_L1P_URL.replace(/\/$/, '')}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const balance = async (owner: typeof wallet, tokenid: string) => (await owner.calculateAllSpendCandidates(null, false))
      .reduce((sum, candidate) => candidate.getUTXO()?.getTokenId() === tokenid
        ? sum + candidate.getUTXO()!.getValue().getValue() : sum, 0n);
    await expect.poll(() => post('getPredictionState', { contractTokenid: 'probe' })
      .then((result) => result.contractTokenid === 'probe').catch(() => false),
    { timeout: 600000, intervals: [5000], message: 'prediction state API must be ready' }).toBe(true);
    await expect.poll(() => balance(wallet, 'bc'), { timeout: 600000, intervals: [5000],
      message: 'prediction operator must have confirmed collateral' }).toBeGreaterThanOrEqual(1000000n);
    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    await configurePredictionChain(page, E2E_L1P_URL);
    await importAndUnlock(page, privateKey, PASSWORD);
    await clickTab(page, 'Predict');

    // 1. create — a fresh market per run so re-runs never inherit vault state.
    await page.getByTestId('predict-create').click();
    await page.getByTestId('predict-question').fill(question);
    await page.getByTestId('predict-supply').fill('1000000');
    await page.getByTestId('predict-outcomes').fill('UP\nDOWN');
    await page.getByTestId('predict-resolution-days').fill('0.006');
    await page.getByTestId('predict-dispute-window').fill('30');
    await page.getByTestId('predict-create-submit').click();

    // The created market must surface in the list (the token + create event land
    // on L1P; a rejected block or a missing domain multisign leaves it absent).
    const card = page.locator('[data-testid^="predict-event-"]').filter({ hasText: question });
    await expect(card).toBeVisible({ timeout: 240000 });
    await expect(card.getByTestId('predict-status')).toHaveText('Open', { timeout: 240000 });
    const markets = await post('searchContractTokens', {});
    const market = markets.tokens.find((token: any) => token.tokenKeyValues?.keyvalues?.some(
      (entry: any) => entry.key === 'question' && entry.value === question));
    expect(market).toBeTruthy();
    const config = Object.fromEntries(market.tokenKeyValues.keyvalues.map((entry: any) => [entry.key, entry.value]));
    expect(config.outcomeNames).toBe('UP,DOWN');
    const [winner, loser] = config.outcomeTokenids.split(',');
    const state = async () => (await post('getPredictionState', { contractTokenid: market.tokenid })).state;

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

    await page.getByTestId('predict-amount').fill('100000');
    await page.getByTestId('predict-split').click();
    await expect(card.getByTestId('predict-position')).toContainText('UP 100000', { timeout: 240000 });
    const counterparty = sdk.PQKey.createNew();
    const buyer = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [counterparty], E2E_L1P_URL);
    const funding = await wallet.payMoneyToECKeyList(null,
      new Map([[sdk.Address.fromKey(sdk.TestParams.get(), counterparty).toString(), 1000000n]]),
      new Uint8Array(sdk.Utils.HEX.decode('bc')), 'prediction-e2e-counterparty',
      await wallet.calculateAllSpendCandidates(null, false));
    expect(funding).not.toBeNull();
    await expect.poll(() => balance(buyer, 'bc'), { timeout: 240000, intervals: [2000] }).toBeGreaterThanOrEqual(1000000n);
    await buyer.buyOrder(null, winner, 1n, 10000n, null, null, 'bc', true);
    await expect.poll(async () => {
      const book = await post('getOrders', { tokenid: winner });
      return (book.allOrdersSorted ?? book.orders ?? []).some((order: any) => order.targetTokenid === winner
        && order.offerTokenid === 'bc' && BigInt(order.targetValue) >= 10000n);
    }, { timeout: 240000, intervals: [2000] }).toBe(true);
    await page.getByTestId('predict-amount').fill('10000');
    await page.getByTestId('predict-sell-0').click();
    await expect(page.getByTestId('predict-quote-fill')).toContainText('10000 / 10000');
    await page.getByTestId('predict-quote-submit').click();
    await expect.poll(() => balance(buyer, winner), { timeout: 240000, intervals: [2000] }).toBe(10000n);
    await expect(card.getByTestId('predict-position')).toContainText('UP 90000', { timeout: 240000 });

    await expect(page.getByTestId('predict-resolve-0')).toBeEnabled({ timeout: 600000 });
    await page.getByTestId('predict-resolve-0').click();
    await page.getByTestId('predict-action-confirm').click();
    await expect.poll(async () => (await state())?.status, { timeout: 240000, intervals: [2000] }).toBe('PENDING');
    const pending = await state();
    expect(pending.proposalOutcome).toBe(winner);
    await expect.poll(() => Math.floor(Date.now() / 1000), { timeout: 120000, intervals: [1000] })
      .toBeGreaterThan(pending.disputeDeadlineSec);
    const collateralBeforeHeartbeat = await balance(wallet, 'bc');
    if ((await state()).status !== 'FINAL') {
      await wallet.payContract(null, 'bc', 0n, null, null, market.tokenid, sdk.PredictionAction.heartbeat());
    }
    await expect.poll(async () => (await state())?.status, { timeout: 240000, intervals: [2000] }).toBe('FINAL');
    await expect.poll(() => balance(wallet, 'bc'), { timeout: 240000, intervals: [2000] })
      .toBeGreaterThanOrEqual(collateralBeforeHeartbeat - sdk.Coin.FEE_DEFAULT.getValue());
    expect((await state()).outcome).toBe(winner);
    await expect(page.getByTestId('predict-redeem')).toBeVisible({ timeout: 240000 });
    const collateralBefore = await balance(wallet, 'bc');
    const losingBefore = await balance(wallet, loser);
    await page.getByTestId('predict-redeem').click();
    await expect.poll(() => balance(wallet, winner), { timeout: 240000, intervals: [2000] }).toBe(0n);
    await expect.poll(() => balance(wallet, 'bc'), { timeout: 240000, intervals: [2000] })
      .toBeGreaterThanOrEqual(collateralBefore + 85000n);
    expect(await balance(wallet, loser)).toBe(losingBefore);
    expect((await state()).redeemed[winner]).toBe('90000');
  });
});
