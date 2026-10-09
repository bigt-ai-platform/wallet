import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, clickTab, goToKeys, fundFromGenesisWallet, waitForConfirmedBc } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

async function importKey(page: Page, privKeyHex: string) {
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privKeyHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
}

async function saveWallet(page: Page, password: string) {
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs('/tmp/order-wallet-e2e.json');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

/**
 * Point the app at the local L0/L1 servers by writing the settings storage
 * directly (the server-URL input and the L1-chain URL inputs share the same
 * placeholder, making the Settings UI helper unreliable).
 */
async function configureUrlsDirect(page: Page, serverUrl: string, l1Url: string) {
  await page.evaluate(
    ([sUrl, chains]) => {
      // Plain dot-joined keys — the web build's storage abstraction reads
      // localStorage directly (mmkv.default\ namespacing is native-only).
      localStorage.setItem('settings.serverUrl', sUrl);
      localStorage.setItem('settings.l1Chains', chains);
      // Local infra is testnet; without this the app uses mainnet address
      // params and rejects testnet addresses.
      localStorage.setItem('settings.useTestnet', 'true');
    },
    [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])]
  );
}

test.describe('Order Screen', () => {
  test('order screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'My Orders');
    const screen = await getElement(page, 'order-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows the My Orders page with status filters', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'My Orders');
    await expect(page.getByText('Your Orders').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByTestId('order-status-filter-pending')).toBeAttached({ timeout: 5000 });
    await expect(page.getByTestId('order-status-filter-confirmed')).toBeAttached({ timeout: 5000 });
    await expect(page.getByTestId('order-status-filter-cancelled')).toBeAttached({ timeout: 5000 });
    await expect(page.getByTestId('order-status-filter-failed')).toBeAttached({ timeout: 5000 });
  });

  test('toggles order status filters (multi-select)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'My Orders');
    const pending = page.getByTestId('order-status-filter-pending');
    const confirmed = page.getByTestId('order-status-filter-confirmed');
    await pending.click();
    await confirmed.click();
    // Multiple statuses can be active at once and the page stays usable.
    await expect(page.getByTestId('my-orders-tab')).toBeAttached({ timeout: 5000 });
    await pending.click();
    await confirmed.click();
    await expect(page.getByTestId('my-orders-tab')).toBeAttached({ timeout: 5000 });
  });

  /**
   * Port of the Java/TS remote order test (RemoteOrderTests.testCreateTokenAndTrade),
   * but the wallet is set up through the APP UI exactly like the payment test
   * ("same payment base"): the seller key is generated in Node, funded on the
   * L0 payment base via fundAddresses, imported into the app wallet, and the
   * sell order is then placed through the Order tab UI. The executed match is
   * what feeds getOrdersTicker — the market-price list and the chart data.
   *
   * The token must exist on the L1 order chain with REAL on-chain BC (from the
   * genesis wallet) for the order transaction to be accepted — fundAddresses
   * coinbases are virtual and cannot be spent on the L1 order chain.
   */
  test('place sell order via Sell page UI after wallet setup (requires server)', async ({ page }) => {
    test.setTimeout(480000);
    test.skip(!HAS_SERVER || !E2E_L1_URL, 'E2E_SERVER_URL / E2E_L1_URL not set');

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

    // Pay each beneficiary real on-chain BC from the genesis wallet.
    const payBigTo = async (fromWallet: any, keys: any[], amount: bigint) => {
      const giveMoney = new Map<string, bigint>();
      for (const k of keys) {
        giveMoney.set(sdk.Address.fromKey(sdk.TestParams.get(), k).toString(), amount);
      }
      const coinList = await fromWallet.calculateAllSpendCandidates(null, false);
      expect(coinList.length).toBeGreaterThan(0);
      const tx = await fromWallet.payMoneyToECKeyList(
        null, giveMoney, new Uint8Array(sdk.Utils.HEX.decode(bcToken)),
        'e2e-order-ui', coinList,
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

    // 1. Genesis wallet (ML-DSA-87 seed 0x01, the root domain signer) funds
    //    both traders with REAL on-chain BC on the L1 order chain. Mirrors
    //    RemoteTest.setUp + RemoteOrderTests.
    const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
    const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], l1Url);
    wallet.setServerURL(l1Url);

    const issuer = sdk.PQKey.createNew(); // seller
    const buyer = sdk.PQKey.createNew();
    const userFunds = sdk.CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);

    console.log('Funding issuer + buyer with real BC on L1...');
    await payBigTo(wallet, [issuer, buyer], userFunds);
    await waitForConfirmedBalance(issuer, bcToken);
    await waitForConfirmedBalance(buyer, bcToken);
    console.log('Issuer and buyer funded with BC');

    // 2. Create a tradable token (tokenid = issuer's prefixed pubkey). The
    //    issuer holds the token UTXOs, so he can place a sell order.
    const tokenName = 'e2etrade_' + Date.now().toString(36);
    const tokenid = sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    const token = new sdk.Token(tokenid, tokenName);
    token.setDescription('e2e order-match chart data');
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
    console.log('Token block submitted');

    const signed = await wallet.multiSign(tokenid, genesisKey, null);
    expect(signed).not.toBeNull();
    console.log('Token multi-signed');

    await waitForConfirmedBalance(issuer, tokenid);
    console.log('Token UTXOs confirmed');

    // 3. Payment base (same as the payment test): fund the seller's L0 address
    //    from the genesis wallet (real on-chain BC — the Java server removed
    //    the fundAddresses faucet) so the app wallet is funded on L0.
    const sellerAddress = sdk.Address.fromKey(sdk.TestParams.get(), issuer).toString();
    await fundFromGenesisWallet(E2E_SERVER_URL, [issuer], BigInt(10000000000));
    await waitForConfirmedBc(issuer, E2E_SERVER_URL);
    console.log('Funded seller on L0 payment base', sellerAddress);

    // 4. App UI wallet setup (same base as the payment test): point the app at
    //    L0 + L1, import the seller key, save with password, unlock.
    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    await goToKeys(page);
    await importKey(page, issuer.getPrivateKeyHex());
    await saveWallet(page, PASSWORD);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);

    // 5. Place the sell order through the dedicated Sell page. The Java L0
    //    server does not implement getMarketPrices, so feed its price list with
    //    our token; the order itself is submitted to the L1 order server.
    const sellPrice = BigInt(1000);
    const tradeAmount = BigInt(100);
    await page.route('**/getMarketPrices', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          prices: [{
            tokenid,
            tokenname: tokenName,
            price: '1000',
            change: '0',
            executedquantity: '0',
            decimals: 0,
          }],
        }),
      });
    });

    await clickTab(page, 'Sell');
    // The Sell page auto-selects the first (mocked) market price.
    await expect(page.getByTestId('token-selected')).toContainText(tokenName, { timeout: 30000 });
    await page.getByTestId('token-order-price').fill('1000');
    await page.getByTestId('token-order-amount').fill('100');

    // The UI submits the order transaction to the L1 order server. Alert.alert
    // is a no-op in react-native-web, so wait for the actual submit request
    // instead of a dialog.
    const submitReq = page
      .waitForRequest(
        (req) => req.url().includes(l1Url) && req.url().includes('submitTransaction'),
        { timeout: 60000 }
      )
      .catch(() => null);
    await page.getByTestId('token-order-submit').click();
    const req = await submitReq;
    expect(req).not.toBeNull();
    console.log('Sell order submitted via Sell page UI to L1');

    // 7. The order book shows the open sell order (getOrders, order data).
    // Wait specifically for OUR order: getOrders returns every token's open
    // orders, so breaking on `length > 0` exits early whenever another market
    // has an open order (e.g. a prior test left one).
    let sellOrders: any[] = [];
    let ourSell: any;
    for (let i = 0; i < 90; i++) {
      const resp = await postJson('getOrders', {});
      sellOrders = resp.allOrdersSorted || [];
      ourSell = sellOrders.find((o: any) => o.offerTokenid === tokenid);
      if (ourSell) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(sellOrders.length).toBeGreaterThanOrEqual(1);
    expect(ourSell).toBeDefined();
    console.log(`Sell order open in book: ${sellOrders.length} order(s)`);

    // 8. Crossing buy order for the full amount → full match.
    const buyerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], l1Url);
    buyerWallet.setServerURL(l1Url);
    await buyerWallet.buyOrder(
      null, tokenid, sellPrice, tradeAmount, null, null, bcToken, false,
    );
    console.log(`Buy: ${tradeAmount} ${tokenName} @ price ${sellPrice}`);

    // Wait for OUR orders to be fully matched (getOrders is shared across
    // markets, so only count orders that touch this token).
    let remaining: any[] = [null];
    for (let i = 0; i < 90; i++) {
      const resp = await postJson('getOrders', {});
      remaining = (resp.allOrdersSorted || []).filter(
        (o: any) => o.offerTokenid === tokenid || o.targetTokenid === tokenid,
      );
      if (remaining.length === 0) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(remaining.length).toBe(0);
    console.log('Orders matched on L1');

    // 9. Market data: getOrdersTicker (count mode → last matching events)
    //    returns the executed match with price / volume / time.
    let tickers: any[] = [];
    let tickerTokenName: string | null = null;
    for (let i = 0; i < 30; i++) {
      const resp = await postJson('getOrdersTicker', {
        tokenids: [tokenid], basetoken: bcToken, count: 10,
      });
      tickers = (resp.tickers || []).filter((t: any) => t.tokenid === tokenid);
      if (resp.tokennames?.[tokenid]?.tokenname) {
        tickerTokenName = resp.tokennames[tokenid].tokenname;
      }
      if (tickers.length > 0) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(tickers.length).toBeGreaterThan(0);
    const ticker = tickers[0];
    expect(Number(ticker.price)).toBe(Number(sellPrice));
    expect(Number(ticker.executedQuantity)).toBe(Number(tradeAmount));
    expect(Number(ticker.inserttime)).toBeGreaterThan(0);
    expect(ticker.txhash).toBeDefined();
    expect(ticker.basetokenid ?? ticker.baseTokenId ?? '').toBe(bcToken);
    expect(tickerTokenName).toBe(tokenName);
    console.log('Market ticker:', JSON.stringify(ticker));

    // 10. Chart data: getOrdersTicker in time-series mode over the last few
    //     minutes returns the same executed match as a chart point.
    const endMs = Date.now();
    const startMs = endMs - 10 * 60 * 1000;
    const seriesResp = await postJson('getOrdersTicker', {
      tokenids: [tokenid], basetoken: bcToken,
      interval: '10', startDate: startMs, endDate: endMs,
    });
    const series: any[] = (seriesResp.tickers || []).filter(
      (t: any) => t.tokenid === tokenid,
    );
    expect(series.length).toBeGreaterThan(0);
    const point = series[series.length - 1];
    // The chart is fed by the same executed match as the market ticker.
    expect(Number(point.price)).toBe(Number(sellPrice));
    expect(Number(point.executedQuantity)).toBe(Number(tradeAmount));
    expect(Number(point.inserttime)).toBeGreaterThan(0);
    expect(point.txhash).toBe(ticker.txhash);
    console.log('Chart point:', JSON.stringify(point));
  });
});
