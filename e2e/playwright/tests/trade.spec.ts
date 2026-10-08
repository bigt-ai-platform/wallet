import { test, expect, Page } from '@playwright/test';
import { waitForApp } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const L1_READY = HAS_SERVER && !!E2E_L1_URL;

/**
 * Point the app at the local L0/L1 servers by writing the settings storage
 * directly (same approach as order.spec — the Settings UI helper
 * is unreliable because the server-URL and L1-chain inputs share a placeholder).
 */
async function configureUrlsDirect(page: Page, serverUrl: string, l1Url: string) {
  await page.evaluate(
    ([sUrl, chains]) => {
      localStorage.setItem('settings.serverUrl', sUrl);
      localStorage.setItem('settings.l1Chains', chains);
      localStorage.setItem('settings.useTestnet', 'true');
    },
    [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])],
  );
}

/**
 * Builds a live market on the L1 order chain: fund two traders with real
 * on-chain BC, create a tradable token, place a sell order and a *smaller*
 * crossing buy so the book keeps an open ask AND records an executed match —
 * feeding the order book, the recent-trades list and the chart in one shot.
 * Mirrors the Java remote order test.
 */
async function setupMarket(quote: 'bc' | 'CNY' = 'bc'): Promise<{ tokenid: string; tokenName: string }> {
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const l1Url = E2E_L1_URL.replace(/\/+$/, '') + '/';
  const bcToken = sdk.NetworkParameters.BIGTANGLE_TOKENID_STRING;

  const postJson = async (endpoint: string, body: any): Promise<any> => {
    const res = await fetch(l1Url + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  const payTo = async (fromWallet: any, keys: any[], amount: bigint, tokenid: string) => {
    const giveMoney = new Map<string, bigint>();
    for (const k of keys) {
      giveMoney.set(sdk.Address.fromKey(sdk.TestParams.get(), k).toString(), amount);
    }
    const coinList = await fromWallet.calculateAllSpendCandidates(null, false);
    expect(coinList.length).toBeGreaterThan(0);
    const tx = await fromWallet.payMoneyToECKeyList(
      null, giveMoney, new Uint8Array(sdk.Utils.HEX.decode(tokenid)),
      'e2e-trade', coinList,
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
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Timeout waiting for ${tokenid} balance to confirm`);
  };

  const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
  const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], l1Url);
  wallet.setServerURL(l1Url);

  const issuer = sdk.PQKey.createNew();
  const buyer = sdk.PQKey.createNew();
  const userFunds = sdk.CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);
  await payTo(wallet, [issuer, buyer], userFunds, bcToken);
  await waitForConfirmedBalance(issuer, bcToken);
  await waitForConfirmedBalance(buyer, bcToken);

  // CNY quote: create (or reuse) the fixed-seed 0x05 "CNY" token on L1 and
  // hand the buyer some supply, mirroring the remote order test.
  let cnyTokenid = '';
  if (quote === 'CNY') {
    const cnyIssuer = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x05));
    cnyTokenid = sdk.Utils.HEX.encode(cnyIssuer.getPrefixedPublicKeyBytes());
    // The network fee on a token payment is still BC, so the issuer needs some.
    await payTo(wallet, [cnyIssuer], userFunds, bcToken);
    await waitForConfirmedBalance(cnyIssuer, bcToken);
    const cnyWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [cnyIssuer], l1Url);
    cnyWallet.setServerURL(l1Url);
    let cnyExists = true;
    try {
      await cnyWallet.checkTokenId(cnyTokenid);
    } catch {
      cnyExists = false;
    }
    if (!cnyExists) {
      const cnyToken = new sdk.Token(cnyTokenid, 'CNY');
      cnyToken.setDescription('e2e CNY quote token');
      cnyToken.setDecimals(0);
      cnyToken.setAmount(BigInt(100000000));
      cnyToken.setTokenstop(true);
      cnyToken.setTokenindex(0);
      cnyToken.setSignnumber(0);
      cnyToken.setDomainNameBlockHash('');
      cnyToken.setPrevblockhash(sdk.Sha256Hash.ZERO_HASH);
      cnyToken.setTokentype(sdk.TokenType.token);
      const cnyAddr = new sdk.MultiSignAddress(
        cnyTokenid, '', sdk.Utils.HEX.encode(cnyIssuer.getPrefixedPublicKeyBytes()), 0,
      );
      const cnyBlock = await wallet.createToken(
        cnyIssuer, '', true, cnyToken, [cnyAddr], cnyIssuer.getPubKey(), new sdk.MemoInfo('coinbase'),
      );
      expect(cnyBlock).toBeDefined();
      const signedCny = await wallet.multiSign(cnyTokenid, genesisKey, null);
      expect(signedCny).not.toBeNull();
    }
    await waitForConfirmedBalance(cnyIssuer, cnyTokenid);
    await payTo(cnyWallet, [buyer], BigInt(1000000), cnyTokenid);
    await waitForConfirmedBalance(buyer, cnyTokenid);
  }
  const quoteTokenId = quote === 'CNY' ? cnyTokenid : bcToken;

  const tokenName = 'e2etradeui_' + Date.now().toString(36);
  const tokenid = sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
  const token = new sdk.Token(tokenid, tokenName);
  token.setDescription('e2e trade screen order book');
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

  // Raw price scale = token decimals (0) + quote shift (0 for bc, 6 for CNY).
  const price = quote === 'CNY' ? BigInt(1000) * BigInt(1000000) : BigInt(1000);
  const sellAmount = BigInt(100);
  const buyAmount = BigInt(40);
  const issuerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [issuer], l1Url);
  issuerWallet.setServerURL(l1Url);
  await issuerWallet.sellOrder(null, tokenid, price, sellAmount, null, null, quoteTokenId, true);

  const buyerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], l1Url);
  buyerWallet.setServerURL(l1Url);
  await buyerWallet.buyOrder(null, tokenid, price, buyAmount, null, null, quoteTokenId, false);

  // Wait until the remainder ask is open AND the executed match shows up in
  // getOrdersTicker (the data behind the order book and recent trades).
  let openAsk = false;
  let matched = false;
  for (let i = 0; i < 60 && !(openAsk && matched); i++) {
    const book = await postJson('getOrders', {});
    openAsk = (book.allOrdersSorted || []).some((o: any) => o.offerTokenid === tokenid);
    const tick = await postJson('getOrdersTicker', { tokenids: [tokenid], basetoken: quoteTokenId, count: 10 });
    matched = (tick.tickers || []).some((t: any) => t.tokenid === tokenid);
    if (!(openAsk && matched)) await new Promise((r) => setTimeout(r, 2000));
  }
  expect(openAsk, 'remainder sell order should stay open in the book').toBe(true);
  expect(matched, 'the small crossing buy should produce a match ticker').toBe(true);

  console.log(`Trade market ready: ${tokenName} (open ask + match)`);
  return { tokenid, tokenName };
}

test.describe('Trade Screen', () => {
  test('trade screen is reachable from the sidebar', async ({ page }) => {
    await waitForApp(page);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Spot', exact: true }).click();
    await expect(page.getByTestId('trade-screen')).toBeAttached({ timeout: 10000 });
    // The three Binance panels are mounted (order book, chart, recent trades).
    await expect(page.getByTestId('trade-orderbook')).toBeAttached();
    await expect(page.getByTestId('trade-recent-trades')).toBeAttached();
  });

  test('renders live order book, recent trades and chart (requires L1)', async ({ page }) => {
    test.skip(!L1_READY, 'E2E_SERVER_URL / E2E_L1_URL not set');
    test.setTimeout(600000);

    const ctx = await setupMarket();

    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Spot', exact: true }).click();
    await expect(page.getByTestId('trade-screen')).toBeAttached({ timeout: 10000 });

    // Search the L1 exchange tokens and select the market.
    await page.getByTestId('trade-token-search').fill(ctx.tokenName);
    const chip = page.getByTestId('trade-token-results').getByText(ctx.tokenName);
    await expect(chip).toBeAttached({ timeout: 15000 });
    await chip.click();
    await expect(page.getByTestId('trade-selected-token')).toBeAttached({ timeout: 10000 });

    // Chart (price line + volume bars) from the getOrdersTicker series.
    await expect(page.locator('[data-testid="trade-chart-price"] polyline')).toBeAttached({ timeout: 20000 });
    await expect(page.locator('[data-testid="trade-chart-volume"] rect').first()).toBeAttached({ timeout: 10000 });

    // Order book: the open ask at price 1000 / remaining amount 60.
    const asks = page.getByTestId('trade-asks');
    await expect(asks).toBeAttached({ timeout: 10000 });
    await expect(asks.getByText(/1[,.]?000/)).toBeAttached({ timeout: 20000 });

    // Recent trades: the executed match (price 1000, amount 40).
    const trades = page.getByTestId('trade-recent-trades');
    await expect(trades).toBeAttached();
    await expect(trades.getByText(/1[,.]?000/).first()).toBeAttached({ timeout: 20000 });
    console.log('Trade screen rendered book + trades + chart for', ctx.tokenName);
  });

  test('renders a CNY-quoted market (requires L1)', async ({ page }) => {
    test.skip(!L1_READY, 'E2E_SERVER_URL / E2E_L1_URL not set');
    test.setTimeout(600000);

    const ctx = await setupMarket('CNY');

    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: 'Spot', exact: true }).click();
    await expect(page.getByTestId('trade-screen')).toBeAttached({ timeout: 10000 });

    await page.getByTestId('trade-token-search').fill(ctx.tokenName);
    const chip = page.getByTestId('trade-token-results').getByText(ctx.tokenName);
    await expect(chip).toBeAttached({ timeout: 15000 });
    await chip.click();
    await expect(page.getByTestId('trade-selected-token')).toBeAttached({ timeout: 10000 });

    // The quote selector discovered CNY on the L1 chain; switch the pair over.
    const cnyChip = page.getByTestId('trade-quote-cny');
    await expect(cnyChip).toBeAttached({ timeout: 15000 });
    await cnyChip.click();
    await expect(page.getByTestId('trade-selected-token')).toContainText('CNY');

    // The book/chart/trades are now fetched with basetoken = the CNY id and
    // the shift-6 price scale (raw 1e9 renders as 1000).
    await expect(page.locator('[data-testid="trade-chart-price"] polyline')).toBeAttached({ timeout: 20000 });
    const asks = page.getByTestId('trade-asks');
    await expect(asks.getByText(/1[,.]?000/)).toBeAttached({ timeout: 20000 });
    const trades = page.getByTestId('trade-recent-trades');
    await expect(trades.getByText(/1[,.]?000/).first()).toBeAttached({ timeout: 20000 });
    console.log('Trade screen rendered CNY-quoted book + trades + chart for', ctx.tokenName);
  });
});
