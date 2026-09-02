import { test, expect, Page } from '@playwright/test';
import { waitForApp, getElement, clickTab, configureServerUrl, goToKeys, goToPayment, fundFromGenesisWallet, waitForConfirmedBc } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TokenTestPass123!';

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
  if (d) await d.saveAs('/tmp/tokens-wallet-e2e.json');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

test.describe('Tokens Screen', () => {
  test('tokens screen is in the DOM after navigating to tab', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    const screen = await getElement(page, 'tokens-screen');
    await expect(screen).toBeAttached({ timeout: 10000 });
  });

  test('shows search input and token list', async ({ page }) => {
    await waitForApp(page);
    await clickTab(page, 'Tokens');
    await expect(page.getByPlaceholder('Search by name or ID').first()).toBeAttached({ timeout: 10000 });
  });

  test('BIG token exists on server (requires server)', async ({ request }) => {
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const searchResp = await request.post(`${E2E_SERVER_URL}searchTokens`, {
      data: {},
    });
    expect(searchResp.ok()).toBeTruthy();
    const searchBody = await searchResp.json();
    expect(searchBody.tokens).toBeDefined();
    const big = searchBody.tokens.find((t: any) => t.tokenname === 'BIG');
    expect(big).toBeDefined();
    expect(big.tokenid).toBe('bc');
    expect(big.decimals).toBe(6);
    expect(big.description).toBeDefined();

    const byIdResp = await request.post(`${E2E_SERVER_URL}getTokenById`, {
      data: { tokenid: 'bc' },
    });
    expect(byIdResp.ok()).toBeTruthy();
    const byIdBody = await byIdResp.json();
    expect(byIdBody.tokens).toBeDefined();
    expect(byIdBody.tokens.length).toBeGreaterThan(0);
    expect(byIdBody.tokens[0].tokenname).toBe('BIG');
    expect(byIdBody.tokens[0].tokenid).toBe('bc');
    expect(byIdBody.tokens[0].decimals).toBe(6);

    console.log('BIG token verified via searchTokens and getTokenById');
  });

  test('create a token and sign via SDK (requires server)', async () => {
    test.setTimeout(300000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');

    // Mirrors RemoteTokenIT.testCreateToken: the genesis wallet (ML-DSA-87
    // seed 0x01, root domain signer) creates the token and pays the fee from
    // its real on-chain BC — the same creation path the order/chart specs use
    // (tokenid = prefixed pubkey, increment=true, permissioned address, then
    // multiSign by the genesis key). fundAddresses coinbases are virtual and
    // cannot pay the L0 fee, so the issuer is NOT funded here.
    const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
    const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], E2E_SERVER_URL);
    wallet.setServerURL(E2E_SERVER_URL);

    const issuer = sdk.PQKey.createNew();
    const tokenId = issuer.getPublicKeyAsHex(); // prefixed pubkey
    const tokenName = 'E2ETest_' + Date.now().toString(36);

    const token = new sdk.Token(tokenId, tokenName);
    token.setDescription('E2E token creation test');
    token.setDecimals(2);
    token.setAmount(1000000n);
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash('');
    token.setPrevblockhash(sdk.Sha256Hash.ZERO_HASH);
    token.setTokentype(sdk.TokenType.token);

    const addr = new sdk.MultiSignAddress(
      tokenId, '', issuer.getPublicKeyAsHex(), 0,
    );
    const block = await wallet.createToken(
      issuer, '', true, token, [addr], issuer.getPubKey(), new sdk.MemoInfo('coinbase'),
    );
    expect(block).toBeDefined();
    console.log('Token block submitted, hash:', block.getHashAsString());

    // Multisig: the genesis wallet signs the token creation (RemoteTokenIT →
    // wallet.multiSign(tokenId, genesisKey, aesKey)).
    const signed = await wallet.multiSign(tokenId, genesisKey, null);
    if (signed) {
      // Java bakes the reward block (makeRewardBlock → 2s sleep) so the signed
      // block can confirm on the chain's own schedule.
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Verify on-chain (mirrors RemoteTokenIT.testCreateToken): the created
    // token must become queryable via getTokenById once confirmed.
    let found: any = null;
    for (let i = 0; i < 20; i++) {
      try {
        found = await wallet.checkTokenId(tokenId);
        break;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    expect(found).not.toBeNull();
    expect(found.getTokenname()).toBe(tokenName);
    expect(found.getTokenid()).toBe(tokenId);
    expect(found.getDecimals()).toBe(2);
    console.log('Token queryable on-chain:', tokenId);

    // The issuer must hold the minted token UTXOs (confirmed & spendable).
    const issuerWallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [issuer], E2E_SERVER_URL);
    let minted = false;
    for (let i = 0; i < 20; i++) {
      const cands = await issuerWallet.calculateAllSpendCandidates(null, false);
      if (cands.some(
        (c: any) =>
          c.getUTXO()?.getTokenId() === tokenId &&
          c.getUTXO()?.getValue()?.getValue() > BigInt(0),
      )) { minted = true; break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(minted).toBe(true);
    console.log('Token minted UTXOs confirmed for issuer');
  });

  test('fund wallet and send BIG payment via UI (requires server)', async ({ page, request }) => {
    test.setTimeout(360000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    await waitForApp(page);
    await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);

    // Generate the wallet key in Node so we can fund by base58 (the network
    // spends classic base58 addresses; the app UI shows PQ hex).
    const { PQKey, Address, TestParams } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );
    const aliceKey = PQKey.createNew();
    const aliceBase58 = Address.fromKey(TestParams.get(), aliceKey).toString();
    const alicePrivHex = aliceKey.getPrivateKeyHex();

    // Import the key into the app
    await goToKeys(page);
    await importKey(page, alicePrivHex);
    await saveWallet(page, PASSWORD);

    // Fund the wallet with real on-chain BC from the genesis wallet (the Java
    // server removed the fundAddresses faucet — bootstrap is via genesis CSV).
    await fundFromGenesisWallet(E2E_SERVER_URL, [aliceKey], BigInt(10000000000));
    // The payment needs a confirmed BC source to spend.
    await waitForConfirmedBc(aliceKey, E2E_SERVER_URL);
    console.log('Funded wallet', aliceBase58);

    // Wallet is unlocked after save — reload and unlock
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);
    await goToPayment(page);
    await page.waitForTimeout(3000);

    // Fill send form and send to Bob's base58 address
    const bobKey = PQKey.createNew();
    const bobAddress = Address.fromKey(TestParams.get(), bobKey).toString();

    let submitted = false;
    // Auto-accept dialogs (the send uses window.confirm on web; accepting it
    // resolves confirm to true so the send proceeds).
    page.on('dialog', (d) => d.accept().catch(() => {}));
    page.on('request', (req) => {
      if (req.url().includes('submitTransaction')) submitted = true;
    });

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');

    // The screen has a "Send Payment" heading AND button — click the button.
    await page.getByText('Send Payment').last().click();
    // Wait for the send to submit a transaction with the amount.
    await page.waitForTimeout(4000);

    // The send must actually submit a transaction with the amount.
    expect(submitted).toBe(true);
    console.log('UI send submitted transaction:', submitted);

    // Verify on-chain (same flow as the transaction.spec.ts payment test): the
    // L0 transactionstatus table keys records by the first output (recipient),
    // so poll Bob's address until a CONFIRMED transaction appears.
    const { Wallet, TestParams: TP } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );
    let confirmedTx: any = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusResp = await request.post(
        `${E2E_SERVER_URL}getTransactionsStatusByAddress`,
        { data: { address: bobAddress } }
      );
      const data = await statusResp.json();
      confirmedTx = (data.transactions || []).find(
        (t: any) => t.status === 'CONFIRMED'
      );
      if (confirmedTx) break;
    }
    expect(confirmedTx).not.toBeNull();
    expect(confirmedTx.status).toBe('CONFIRMED');
    console.log('UI send confirmed on-chain:', confirmedTx.txHash);

    // Bob's wallet must actually hold the received BIG UTXO on L0.
    const bobWallet = Wallet.fromKeysURL(TP.get(), [bobKey], E2E_SERVER_URL);
    let received = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cands = await bobWallet.calculateAllSpendCandidates(null, false);
      if (cands.some(
        (c: any) =>
          c.getUTXO()?.getTokenId() === 'bc' &&
          c.getUTXO()?.getValue()?.getValue() > BigInt(0),
      )) { received = true; break; }
    }
    expect(received).toBe(true);
    console.log('Bob received BIG on L0 via UI send');
  });
});
