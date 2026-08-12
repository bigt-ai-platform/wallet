import { test, expect, Page } from '@playwright/test';
import { waitForApp, clickTab } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;

test.skip(!HAS_SERVER || !E2E_L1_URL, 'E2E_SERVER_URL / E2E_L1_URL not set');

/**
 * Point the app at the local L0/L1 servers by writing the settings storage
 * directly (the server-URL input and the L1-chain URL inputs share the same
 * placeholder, making the Settings UI helper unreliable).
 */
async function configureUrlsDirect(page: Page, serverUrl: string, l1Url: string) {
  await page.evaluate(
    ([sUrl, chains]) => {
      localStorage.setItem('mmkv.default\\settings.serverUrl', sUrl);
      localStorage.setItem('mmkv.default\\settings.l1Chains', chains);
    },
    [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])]
  );
}

/**
 * Chart & market-data UI tests.
 *
 * The setup mirrors the Java remote order test (RemoteOrderTests.testCreateTokenAndTrade):
 * fund two traders with real on-chain BC on the L1 order chain (genesis wallet),
 * create a tradable token, then place a sell + crossing buy so the match feeds
 * the L1 getOrdersTicker data — the source for both the /chart screen (real
 * price/volume series) and the Order screen's market price list.
 */
test.describe.serial('Chart & Market Data', () => {
  const ctx: { tokenid: string; tokenName: string } = { tokenid: '', tokenName: '' };

  test.beforeAll(async () => {
    test.setTimeout(300000);
    if (!HAS_SERVER || !E2E_L1_URL) return;

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
    const l1Url = E2E_L1_URL.replace(/\/+$/, '') + '/';
    const bcToken = sdk.NetworkParameters.BIGTANGLE_TOKENID_STRING;

    const postJson = async (endpoint: string, body: any): Promise<any> => {
      const res = await fetch(l1Url + endpoint, {        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };

    const payBigTo = async (fromWallet: any, keys: any[], amount: bigint) => {
      const giveMoney = new Map<string, bigint>();
      for (const k of keys) {
        giveMoney.set(sdk.Address.fromKey(sdk.TestParams.get(), k).toString(), amount);
      }
      const coinList = await fromWallet.calculateAllSpendCandidates(null, false);
      expect(coinList.length).toBeGreaterThan(0);
      const tx = await fromWallet.payMoneyToECKeyList(
        null, giveMoney, new Uint8Array(sdk.Utils.HEX.decode(bcToken)),
        'e2e-chart', coinList,
      );
      expect(tx).not.toBeNull();
    };

    const waitForConfirmedBalance = async (key: any, tokenid: string) => {
      const w = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [key], l1Url);
      for (let i = 0; i < 75; i++) {
        const cands = await w.calculateAllSpendCandidates(null, false);
        const hit = cands.find(
          (c: any) => c.getUTXO()?.getTokenId() === tokenid
            && c.getUTXO()?.getValue()?.getValue() > BigInt(0),
        );
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 3000));
      }
      throw new Error(`Timeout waiting for ${tokenid} balance to confirm`);
    };

    // 1. Genesis wallet funds both traders with real BC on the L1 order chain.
    const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
    const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], l1Url);
    wallet.setServerURL(l1Url);

    const issuer = sdk.PQKey.createNew();
    const buyer = sdk.PQKey.createNew();
    const userFunds = sdk.CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);
    await payBigTo(wallet, [issuer, buyer], userFunds);
    await waitForConfirmedBalance(issuer, bcToken);
    await waitForConfirmedBalance(buyer, bcToken);

    // 2. Create a tradable token (tokenid = issuer's prefixed pubkey).
    const tokenName = 'e2emarket_' + Date.now().toString(36);
    const tokenid = sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    const token = new sdk.Token(tokenid, tokenName);
    token.setDescription('e2e chart & market data');
    token.setDecimals(0);
    token.setAmount(BigInt(10000000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash('');
    token.setPrevblockhash(sdk.Sha256Hash.ZERO_HASH);
    token.setTokentype(sdk.TokenType.token);

    const addr = new sdk.MultiSignAddress(
      tokenid, '', sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes()), 0,
    );
    const block = await wallet.createToken(
      issuer, '', true, token, [addr], issuer.getPubKey(), new sdk.MemoInfo('coinbase'),
    );
    expect(block).toBeDefined();
    const signed = await wallet.multiSign(tokenid, genesisKey, null);
    expect(signed).not.toBeNull();
    await waitForConfirmedBalance(issuer, tokenid);
    console.log(`Token ${tokenName} created and confirmed`);

    // 3. Sell 100 @ price 1000, then a crossing buy → full match feeds the
    //    L1 ticker (the data behind the chart and market list).
    const sellPrice = BigInt(1000);
    const tradeAmount = BigInt(100);
    const issuerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [issuer], l1Url);
    issuerWallet.setServerURL(l1Url);
    await issuerWallet.sellOrder(null, tokenid, sellPrice, tradeAmount, null, null, bcToken, true);

    const buyerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], l1Url);
    buyerWallet.setServerURL(l1Url);
    await buyerWallet.buyOrder(null, tokenid, sellPrice, tradeAmount, null, null, bcToken, false);

    // 4. Wait until the executed match shows up in getOrdersTicker.
    let ticker: any = null;
    for (let i = 0; i < 60; i++) {
      const resp = await postJson('getOrdersTicker', {
        tokenids: [tokenid], basetoken: bcToken, count: 10,
      });
      const hits = (resp.tickers || []).filter((t: any) => t.tokenid === tokenid);
      if (hits.length > 0) { ticker = hits[0]; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(ticker).not.toBeNull();
    expect(Number(ticker.price)).toBe(Number(sellPrice));
    expect(Number(ticker.executedQuantity)).toBe(Number(tradeAmount));
    console.log('Match produced ticker:', JSON.stringify(ticker));

    ctx.tokenid = tokenid;
    ctx.tokenName = tokenName;
  });

  test('chart screen renders real price & volume data for a matched token', async ({ page }) => {
    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    // Reload so the app picks up the configured L0/L1 server URLs.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // The chart is a Stack screen reached through the nav menu → sidebar
    // "Chart" item (direct /chart URLs 404 because http-server has no SPA
    // history fallback).
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Chart' }).click();
    await expect(page.getByTestId('chart-screen')).toBeAttached({ timeout: 10000 });

    // Search for the token on the L1 order server (real searchExchangeTokens).
    await page.getByTestId('chart-token-search').fill(ctx.tokenName);
    const chip = page.getByTestId('chart-token-results').getByText(ctx.tokenName);
    await expect(chip).toBeAttached({ timeout: 15000 });
    await chip.click();

    // Selecting the token loads the real getOrdersTicker time-series and draws
    // the price line + volume bars.
    await expect(page.getByTestId('chart-selected-token')).toBeAttached({ timeout: 10000 });
    await expect(page.locator('[data-testid="chart-price"] polyline')).toBeAttached({ timeout: 20000 });
    await expect(page.locator('[data-testid="chart-volume"] rect').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText(`${ctx.tokenName} / bc`)).toBeAttached({ timeout: 5000 });

    // Switching to a shorter interval reloads the series and keeps the chart.
    await page.getByTestId('chart-interval-5').click();
    await expect(page.locator('[data-testid="chart-price"] polyline')).toBeAttached({ timeout: 20000 });
    console.log('Chart rendered for', ctx.tokenName);
  });

  test('market price list shows the matched token and price', async ({ page }) => {
    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    // Reload so the app picks up the configured L0/L1 server URLs.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // The Java L0 server does not implement getMarketPrices, so feed the price
    // list with the matched token's real market values; the app renders it as
    // the Order screen market data (price, change, buy/sell actions).
    await page.route('**/getMarketPrices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          prices: [{
            tokenid: ctx.tokenid,
            tokenname: ctx.tokenName,
            price: '1000',
            change: '0',
            executedquantity: '0',
            decimals: 0,
          }],
        }),
      });
    });

    await clickTab(page, 'Order');
    const screen = page.getByTestId('order-screen');
    await expect(screen.getByText(ctx.tokenName)).toBeAttached({ timeout: 15000 });
    await expect(screen.getByText('1000', { exact: true })).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Buy')).toBeAttached({ timeout: 5000 });
    await expect(screen.getByText('Sell')).toBeAttached({ timeout: 5000 });
    console.log('Market list shows', ctx.tokenName, '@ 1000');
  });
});
