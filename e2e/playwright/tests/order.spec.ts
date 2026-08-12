import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

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
      localStorage.setItem('mmkv.default\\settings.serverUrl', sUrl);
      localStorage.setItem('mmkv.default\\settings.l1Chains', chains);
    },
    [serverUrl, JSON.stringify([{ name: 'Default', url: l1Url }])]
  );
}

test.describe('Order Screen', () => {
  test('order screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    const screen = await getElement(page, 'order-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows order tabs (Order and My Orders)', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    await expect(page.getByText('Order').first()).toBeAttached({ timeout: 10000 });
    await expect(page.getByText('My Orders').first()).toBeAttached({ timeout: 5000 });
  });

  test('shows My Orders tab content', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Order');
    await page.getByText('My Orders').click();
    await expect(page.getByText('Your Orders')).toBeAttached({ timeout: 5000 });
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
  test('place sell order via Order UI after wallet setup (requires server)', async ({ page, request }) => {
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
    //    via fundAddresses so the app wallet is funded on the L0 payment base.
    const sellerAddress = sdk.Address.fromKey(sdk.TestParams.get(), issuer).toString();
    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: { addresses: [{ address: sellerAddress, value: 10000000000 }] },
    });
    expect((await fundResp.json()).errorcode).toBe(0);
    console.log('Funded seller on L0 payment base', sellerAddress);

    // 4. App UI wallet setup (same base as the payment test): point the app at
    //    L0 + L1, import the seller key, save with password, unlock.
    await waitForApp(page);
    await configureUrlsDirect(page, E2E_SERVER_URL, E2E_L1_URL);
    await clickTab(page, 'Wallet');
    await (await getElement(page, 'wallet-screen')).getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');
    await importKey(page, issuer.getPrivateKeyHex());
    await saveWallet(page, PASSWORD);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);

    // 5. Order tab UI. The Java L0 server does not implement getMarketPrices,
    //    so feed the price list with our token to open the order sheet; the
    //    sell order itself is submitted to the L1 order server.
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

    await clickTab(page, 'Order');
    await expect(page.getByText(tokenName)).toBeAttached({ timeout: 30000 });
    await page.getByTestId('order-screen').getByText('Sell').click();
    await expect(page.getByText(`Sell ${tokenName}`)).toBeAttached({ timeout: 10000 });

    // 6. Fill the order sheet (price pre-filled from the mocked ticker). The
    //    tab screens stay mounted in the DOM, so scope to the order modal —
    //    global `getByPlaceholder('0.00')` also matches the hidden Transaction
    //    screen's amount input.
    const modal = page.getByRole('dialog');
    const modalInputs = modal.getByPlaceholder('0.00');
    await modalInputs.nth(0).fill('1000');
    await modalInputs.nth(1).fill('100');

    // The UI submits the order transaction to the L1 order server. Alert.alert
    // is a no-op in react-native-web, so wait for the actual submit request
    // instead of a dialog.
    const submitReq = page
      .waitForRequest(
        (req) => req.url().includes(l1Url) && req.url().includes('submitTransaction'),
        { timeout: 60000 }
      )
      .catch(() => null);
    await page.getByText('Place Sell Order').click();
    const req = await submitReq;
    expect(req).not.toBeNull();
    console.log('Sell order submitted via Order UI to L1');

    // 7. The order book shows the open sell order (getOrders, order data).
    let sellOrders: any[] = [];
    for (let i = 0; i < 40; i++) {
      const resp = await postJson('getOrders', {});
      sellOrders = resp.allOrdersSorted || [];
      if (sellOrders.length > 0) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(sellOrders.length).toBeGreaterThanOrEqual(1);
    const ourSell = sellOrders.find((o: any) => o.offerTokenid === tokenid);
    expect(ourSell).toBeDefined();
    console.log(`Sell order open in book: ${sellOrders.length} order(s)`);

    // 8. Crossing buy order for the full amount → full match.
    const buyerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [buyer], l1Url);
    buyerWallet.setServerURL(l1Url);
    await buyerWallet.buyOrder(
      null, tokenid, sellPrice, tradeAmount, null, null, bcToken, false,
    );
    console.log(`Buy: ${tradeAmount} ${tokenName} @ price ${sellPrice}`);

    let remaining: any[] = [null];
    for (let i = 0; i < 60; i++) {
      const resp = await postJson('getOrders', {});
      remaining = resp.allOrdersSorted || [];
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
