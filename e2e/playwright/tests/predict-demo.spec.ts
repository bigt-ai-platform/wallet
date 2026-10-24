import { test, expect, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForApp, clickTab, importAndUnlock, setL1ChainUrl, configureServerUrl } from '../helpers';

/**
 * Predict demo capture (docs/prediction-demo/*.md): creates the nine example
 * markets — US (en), Germany (de), China (zh) — through the real create form on
 * the local L1-prediction chain and saves screenshots for the demo docs.
 *
 * Opt-in: E2E_PREDICT_DEMO=1 plus the predict lifecycle env (E2E_SERVER_URL,
 * E2E_L1P_URL, E2E_PREDICTION_KEY = the funded, domain-authorized operator).
 * Run via `./e2e/e2etest.sh predict-demo`.
 */
const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const E2E_L1P_URL = process.env.E2E_L1P_URL || '';
const E2E_PREDICTION_KEY = process.env.E2E_PREDICTION_KEY || '';
const ENABLED = process.env.E2E_PREDICT_DEMO === '1' && !!E2E_SERVER_URL && !!E2E_L1P_URL && !!E2E_PREDICTION_KEY;
const OUT = resolve(__dirname, '../../../docs/prediction-demo/assets/screenshots');

type Market = {
  question: string;
  outcomes: string[];
  days: string;
  dispute: string;
  autoInvalid: string;
  oracle: 'committee' | 'staked';
  bond: string;
  voteWindow?: string;
};

/** The create-form values from docs/prediction-demo/predict{,.de,.zh}.md. */
const DEMO: { lang: 'en' | 'de' | 'zh'; tag: string; markets: Market[] }[] = [
  { lang: 'en', tag: 'us', markets: [
    { question: 'Will the FOMC lower the federal funds target range at its first scheduled meeting of 2027?',
      outcomes: ['YES', 'NO'], days: '105', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: 'What will the BLS report as US CPI-U year-over-year inflation for December 2026 (not seasonally adjusted, first release)?',
      outcomes: ['Below 2.5%', '2.5% to 3.0%', 'Above 3.0%'], days: '94', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: 'Will the S&P 500 index close above 7000 on December 31, 2026?',
      outcomes: ['YES', 'NO'], days: '71', dispute: '86400', autoInvalid: '1209600', oracle: 'staked', bond: '5000', voteWindow: '172800' },
  ] },
  { lang: 'de', tag: 'de', markets: [
    { question: 'Senkt die EZB den Einlagesatz auf ihrer ersten geldpolitischen Sitzung im Jahr 2027?',
      outcomes: ['JA', 'NEIN'], days: '115', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: 'Welcher Verein wird Deutscher Fußballmeister der Bundesliga-Saison 2026/27?',
      outcomes: ['FC Bayern München', 'Borussia Dortmund', 'Bayer 04 Leverkusen', 'Anderer Verein'], days: '221', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: 'Liegt die Inflationsrate in Deutschland (VPI, Veränderung zum Vorjahresmonat) für Dezember 2026 laut Destatis unter 2,0 %?',
      outcomes: ['JA', 'NEIN'], days: '89', dispute: '86400', autoInvalid: '1209600', oracle: 'staked', bond: '5000', voteWindow: '172800' },
  ] },
  { lang: 'zh', tag: 'cn', markets: [
    { question: '国家统计局首次公布的 2026 年第四季度国内生产总值同比增速是否不低于 5.0%？',
      outcomes: ['是', '否'], days: '89', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: '2027 年春节档（除夕至正月初六）全国电影总票房（含服务费）落在哪个区间？',
      outcomes: ['低于60亿元', '60亿至80亿元', '80亿至100亿元', '100亿元及以上'], days: '120', dispute: '86400', autoInvalid: '2592000', oracle: 'committee', bond: '1000' },
    { question: '国家统计局公布的 2026 年 12 月全国居民消费价格指数（CPI）同比涨幅是否为正？',
      outcomes: ['是', '否'], days: '84', dispute: '86400', autoInvalid: '1209600', oracle: 'staked', bond: '5000', voteWindow: '172800' },
  ] },
];

async function resolvePredictionKey(raw: string): Promise<string> {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return raw;
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(hex.substr(i * 2, 2), 16);
  return sdk.PQKey.fromMLDSA(seed).getPrivateKeyHex();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function createMarket(page: Page, market: Market, committee: string[]) {
  await page.getByTestId('predict-create').click();
  await page.getByTestId('predict-question').fill(market.question);
  await page.getByTestId('predict-outcomes').fill(market.outcomes.join('\n'));
  await page.getByTestId('predict-collateral').fill('bc');
  await page.getByTestId('predict-supply').fill('1000000');
  await page.getByTestId('predict-resolution-days').fill(market.days);
  await page.getByTestId('predict-dispute-window').fill(market.dispute);
  await page.getByTestId('predict-auto-invalid').fill(market.autoInvalid);
  await page.getByTestId(`predict-oracle-${market.oracle}`).click();
  if (market.oracle === 'committee') await page.getByTestId('predict-committee').fill(committee.join('\n'));
  await page.getByTestId('predict-bond').fill(market.bond);
  if (market.voteWindow) await page.getByTestId('predict-vote-window').fill(market.voteWindow);
}

test.describe('Predict demo capture', () => {
  test('creates the US, DE and CN example markets and captures screenshots', async ({ page }) => {
    test.skip(!ENABLED, 'requires E2E_PREDICT_DEMO=1 + E2E_SERVER_URL + E2E_L1P_URL + E2E_PREDICTION_KEY');
    test.setTimeout(90 * 60 * 1000);
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 1000 });

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
    const privateKey = await resolvePredictionKey(E2E_PREDICTION_KEY);
    const operator = sdk.PQKey.fromPrivateKey(new Uint8Array(sdk.Utils.HEX.decode(privateKey)));
    const params = sdk.TestParams.get();
    const wallet = sdk.Wallet.fromKeysURL(params, [operator], E2E_L1P_URL);
    // Back-to-back creates spend the same coins: wait for confirmed change before the next one.
    const confirmedBc = async () => (await wallet.calculateAllSpendCandidates(null, false))
      .reduce((sum: bigint, c: any) => c.getUTXO()?.getTokenId() === 'bc' ? sum + c.getUTXO()!.getValue().getValue() : sum, 0n);
    // 2-of-3 committee: the operator plus two resolver keys (contract addresses are PQ hex).
    const committee = [operator, sdk.PQKey.createNew(), sdk.PQKey.createNew()]
      .map((key: { toAddressString: (p: unknown) => string }) => key.toAddressString(params));

    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    expect(await setL1ChainUrl(page, 'prediction', E2E_L1P_URL), 'no `prediction` L1 chain row').toBe(true);
    await importAndUnlock(page, privateKey, 'PredictDemoPass123!');
    await clickTab(page, 'Predict');
    await expect(page.getByTestId('predict-create')).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('predict-loading')).toHaveCount(0, { timeout: 120000 });
    await expect(page.locator('[data-testid^="predict-event-"]').first().or(page.getByTestId('predict-empty')))
      .toBeVisible({ timeout: 120000 });

    for (const { lang, tag, markets } of DEMO) {
      // The tab label is translated, so switch language in place on the Predict screen.
      await page.evaluate((code) => (globalThis as any).__bigtangleI18n.changeLanguage(code), lang);
      for (const [i, market] of markets.entries()) {
        const n = i + 1;
        const card = page.locator('[data-testid^="predict-event-"]').filter({ hasText: market.question }).first();
        if ((await card.count()) === 0) {
          await expect.poll(confirmedBc, { timeout: 600000, intervals: [5000] }).toBeGreaterThanOrEqual(1000000n);
          await createMarket(page, market, committee);
          await shot(page, `predict-${tag}-${n}-create`);
          for (let attempt = 0; attempt < 5; attempt++) {
            await page.getByTestId('predict-create-submit').click();
            const closed = await page.getByTestId('predict-create-submit').waitFor({ state: 'detached', timeout: 300000 })
              .then(() => true).catch(() => false);
            if (closed) break;
            // "[…:bc] outputs size= 0": the previous spend's change is not confirmed yet.
            await page.waitForTimeout(30000);
          }
        }
        await expect(card).toBeVisible({ timeout: 300000 });
        await expect(card.getByTestId('predict-status')).toBeVisible({ timeout: 300000 });
        await card.click();
        await expect(page.getByTestId('predict-split')).toBeVisible({ timeout: 10000 });
        await card.scrollIntoViewIfNeeded();
        await shot(page, `predict-${tag}-${n}-market`);
        if (n === 1 && (await card.getByTestId('predict-position').count()) === 0) {
          await expect.poll(confirmedBc, { timeout: 600000, intervals: [5000] }).toBeGreaterThanOrEqual(100000n);
          // One split per locale: C collateral -> C shares of every outcome.
          await page.getByTestId('predict-amount').fill('100000');
          await page.getByTestId('predict-split').click();
          await expect(card.getByTestId('predict-position')).toContainText('100000', { timeout: 300000 });
          await shot(page, `predict-${tag}-${n}-split`);
        }
        await card.click();
      }
      await page.getByTestId('predict-filter-mine').click();
      await shot(page, `predict-${tag}-mine`);
      await page.getByTestId('predict-filter-all').click();
    }
  });
});
