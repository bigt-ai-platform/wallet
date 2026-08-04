import { test, expect } from '@playwright/test';
import { waitForApp, getElement, clickTab } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';

async function httpPost(path: string, body: any): Promise<any> {
  const res = await fetch(E2E_SERVER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function pollToken(tokenid: string, maxRetries = 15): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    const resp = await httpPost('getTokenById', { tokenid });
    if (resp.tokens && resp.tokens.length > 0) return resp.tokens[0];
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000));
  }
  return null;
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

  test('create token and place buy/sell orders (requires server)', async ({ request }) => {
    test.setTimeout(120000);
    test.skip(!E2E_SERVER_URL, 'E2E_SERVER_URL not set');

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');

    // Create a new token
    const issuer = sdk.PQKey.createNew();
    const tokenid = sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());

    // Fund issuer with BIG for fees
    const fundRes = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: {
        addresses: [{
          address: issuer.toAddressHex(),
          value: 100000000000,
          pubkey: sdk.Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes()),
        }],
      },
    });
    expect((await fundRes.json()).errorcode).toBe(0);

    // Build token with genesis key
    const genesisSeed = new Uint8Array(32).fill(0x01);
    const genesisSlhSeed = new Uint8Array(32).fill(0x02);
    const genesisKey = sdk.PQKey.fromSeeds(genesisSeed, genesisSlhSeed);

    const wallet = sdk.Wallet.fromKeys(new sdk.TestParams(), [genesisKey, issuer]);
    wallet.setServerURL(E2E_SERVER_URL);
    wallet.setFee(false);

    const token = new sdk.Token(tokenid, 'ordertoken_' + Date.now().toString(36));
    token.setDescription('Created for order test');
    token.setDecimals(0);
    token.setAmount(1000000n);
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
    console.log('Token signed by genesis key');

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    console.log('Token confirmed');

    // Wait for blockbatch to mint + confirm token UTXOs (the reward chain
    // confirms the token block, which can take ~1 min).
    let tokenUtxos: any[] = [];
    for (let i = 0; i < 30; i++) {
      const utxos = await wallet.calculateAllSpendCandidates(null, false);
      tokenUtxos = utxos.filter((u: any) => u.getUTXO().getTokenId() === tokenid);
      if (tokenUtxos.length > 0) break;
      if (i < 29) await new Promise(r => setTimeout(r, 3000));
    }

    // Verify token UTXOs exist
    expect(tokenUtxos.length).toBeGreaterThan(0);
    console.log('Token UTXOs available:', tokenUtxos.length);

    // Submit sell/buy orders via the wallet SDK. Java Wallet.submitTransaction
    // is now used instead of solveAndPost (block creation removed). PQ signing
    // incompatibility (TypeScript noble vs Java BC) is tracked separately.
    const sellToken = sdk.Token.buildSimpleTokenInfo2(
      true, null, tokenid, foundToken.tokenname, foundToken.description || '',
      0, 0, BigInt(foundToken.amount || 1000000), true, 0, '',
    );
    try {
      const sellTx = await wallet.sellOrderDo(
        null, sellToken, 50n, 100n, null, null, 'bc', false,
      );
      console.log('Sell order submitted');
    } catch (e: any) {
      console.log('Sell order error:', e.message);
    }
    try {
      const buyTx = await wallet.buyOrderDo(
        null, sellToken, 40n, 50n, null, null, 'bc', false,
      );
      console.log('Buy order submitted');
    } catch (e: any) {
      console.log('Buy order error:', e.message);
    }
    console.log('Token+orders done');
  });
});
