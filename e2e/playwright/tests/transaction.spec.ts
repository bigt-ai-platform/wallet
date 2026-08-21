import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp, clickTab, getElement, configureServerUrl } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

async function getWalletAddress(page: Page): Promise<string> {
  const addressEl = page.locator('text=/^[0-9a-f]{70}$/').first();
  await expect(addressEl).toBeAttached({ timeout: 10000 });
  return (await addressEl.textContent())!;
}

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
  if (d) await d.saveAs('/dev/null');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);
}

test.describe('Payment', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    if (HAS_SERVER) {
      await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    }
  });

  test('alice sends big to bob', async ({ page, request }) => {
    test.setTimeout(480000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    // 1. Generate Alice's PQ key in Node.js. The network spends UTXOs via
    //    classic base58 addresses (Address.fromKey(...).toString()), while the
    //    app wallet file stores the PQ hex address — so fund/send here use the
    //    base58 form.
    const { PQKey, Address, TestParams } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );

    const aliceKey = PQKey.createNew();
    const aliceAddress = Address.fromKey(TestParams.get(), aliceKey).toString();
    const alicePrivHex = aliceKey.getPrivateKeyHex();

    // 2. Fund Alice via fundAddresses. The server derives the output script
    //    from the base58 address (no pubkey needed); passing a pubkey here
    //    requires a bundle version the Java server rejects.
    const fundResp = await request.post(`${E2E_SERVER_URL}fundAddresses`, {
      data: {
        addresses: [{
          address: aliceAddress,
          value: 10000000000,
        }],
      },
    });
    const fundBody = await fundResp.json();
    expect(fundBody.errorcode).toBe(0);
    console.log('Funded', aliceAddress);

    // 3. Import Alice key into the app
    await clickTab(page, 'Wallet');
    await (await getElement(page, 'wallet-screen')).getByText('Manage Wallet').click();
    await page.waitForURL('**/wallet/keys**');
    await importKey(page, alicePrivHex);
    await saveWallet(page, PASSWORD);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // 4. Unlock Alice
    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);

    // 5. Bob's wallet (in-memory) for his base58 address
    const bobKey = PQKey.createNew();
    const bobAddress = Address.fromKey(TestParams.get(), bobKey).toString();
    console.log('Bob', bobAddress);

    // 6. Wait for Alice's fundAddresses coinbase to be CONFIRMED on L0 before
    //    sending — spending an unconfirmed coinbase can leave the payment
    //    stuck at BATCHED and never confirmed.
    const { Wallet, TestParams: TP } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );
    const aliceWallet = Wallet.fromKeysURL(TP.get(), [aliceKey], E2E_SERVER_URL);
    let aliceReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const cands = await aliceWallet.calculateAllSpendCandidates(null, false);
      if (cands.some(
        (c: any) => c.getUTXO()?.getTokenId() === 'bc' && c.getUTXO()?.isConfirmed(),
      )) {
        aliceReady = true;
        break;
      }
    }
    expect(aliceReady).toBe(true);
    console.log('Alice funding confirmed on L0');

    // 7. Send BIG to Bob
    await page.waitForTimeout(1000);
    await clickTab(page, 'Transaction');
    await page.waitForTimeout(3000);

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');

    // window.confirm (web confirm dialog) — auto-accept so the send proceeds.
    page.on('dialog', (d) => d.accept().catch(() => {}));
    // The screen has a "Send Payment" heading AND button — click the button.
    // The payment must actually be submitted: wait for the L0 submitTransaction
    // request from the app's broadcastTransaction.
    const submitReq = page
      .waitForRequest(
        (req) => req.url().includes(E2E_SERVER_URL) && req.url().includes('submitTransaction'),
        { timeout: 30000 }
      )
      .catch(() => null);
    await page.locator('text=Send Payment').last().click();
    expect(await submitReq).not.toBeNull();
    console.log('Payment submitted via UI');

    // 8. Verify the payment is DONE on-chain and check its transaction status.
    //    The L0 transactionstatus table keys records by the transaction's first
    //    output (the recipient), so wait-check Bob's address until a CONFIRMED
    //    transaction appears.
    let confirmedTx: any = null;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusResp = await request.post(
        `${E2E_SERVER_URL}getTransactionsStatusByAddress`,
        { data: { address: bobAddress } }
      );
      const data = await statusResp.json();
      confirmedTx = (data.transactions || []).find((t: any) => t.status === 'CONFIRMED');
      if (confirmedTx) break;
    }
    expect(confirmedTx).not.toBeNull();
    expect(confirmedTx.txHash).toBeTruthy();
    expect(confirmedTx.status).toBe('CONFIRMED');
    console.log('Payment confirmed:', confirmedTx.txHash, confirmedTx.status);

    // Hand the confirmed payment to e2etest.sh so the harness can independently
    // re-verify the transaction status via the L0 getTransactionStatus API
    // (the test uses random wallets, so the script cannot know the txHash).
    await fs.promises.writeFile(
      path.join(process.cwd(), 'test-results', 'payment-verification.json'),
      JSON.stringify(
        {
          txHash: confirmedTx.txHash,
          status: confirmedTx.status,
          address: bobAddress,
          blockHash: confirmedTx.blockHash ?? null,
          chainlength: confirmedTx.chainlength ?? null,
        },
        null,
        2,
      ),
    );
    console.log('Payment verification handoff written');

    // 9. Bob's wallet on the L0 chain received the BIG payment.
    const bobWallet = Wallet.fromKeysURL(TP.get(), [bobKey], E2E_SERVER_URL);
    let received = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const cands = await bobWallet.calculateAllSpendCandidates(null, false);
      const bc = cands.find(
        (c: any) =>
          c.getUTXO()?.getTokenId() === 'bc' &&
          c.getUTXO()?.getValue()?.getValue() > BigInt(0),
      );
      if (bc) { received = true; break; }
    }
    expect(received).toBe(true);
    console.log('Bob received BIG on L0');
  });
});

test.describe('L1 Test Tab', () => {
  async function ensureWallet(page: Page) {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const { PQKey } = await import('../../../packages/bigtangle-ts/dist/index.js');
    const key = PQKey.createNew();
    const privHex = key.getPrivateKeyHex();
    await clickTab(page, 'Wallet');
    const manageBtn = page.getByText('Manage Wallet');
    if (await manageBtn.isVisible().catch(() => false)) {
      await manageBtn.click();
      await page.waitForURL('**/wallet/keys**', { timeout: 10000 }).catch(() => {});
      await importKey(page, privHex);
      await saveWallet(page, 'Test123!');
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await clickTab(page, 'Transaction');
      await page.waitForTimeout(2000);
      const unlockPwd = page.getByPlaceholder('Enter wallet password');
      if (await unlockPwd.isVisible().catch(() => false)) {
        await unlockPwd.fill('Test123!');
        await page.getByText('Unlock Wallet').click();
        await page.waitForTimeout(2000);
      }
      return;
    }
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  }


  // L1 Test now lives in Settings → Developer (collapsed by default).
  async function openL1Test(page: Page) {
    await clickTab(page, 'Settings');
    await page.getByTestId('developer-toggle').click();
    await page.waitForTimeout(300);
  }

  test('L1 Test harness is available under Settings after wallet unlock', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await expect(page.getByText('Test paying L1 chain and paying back from L1 to Layer 0')).toBeAttached({ timeout: 10000 });
  });

  test('shows L1 chain selector after clicking L1 Test tab', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    await expect(page.getByText('Select L1 Chain')).toBeAttached({ timeout: 5000 });
  });

  test('shows Pay L1 form by default', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    await expect(page.getByText('Pay L1 Chain').first()).toBeAttached({ timeout: 5000 });
    await expect(page.getByPlaceholder('e.g. bc for BIG').first()).toBeAttached({ timeout: 5000 });
    await expect(page.getByPlaceholder('0.00').first()).toBeAttached({ timeout: 5000 });
    await expect(page.getByPlaceholder('L1 address on order chain').first()).toBeAttached({ timeout: 5000 });
  });

  test('switches to Pay Back form', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    await page.getByText('Pay Back L1→L0').click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Pay Back from L1 to L0').first()).toBeAttached({ timeout: 5000 });
    await expect(page.getByText('L0 Destination Address').first()).toBeAttached({ timeout: 5000 });
  });

  test('can fill Pay L1 form', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    await page.getByPlaceholder('e.g. bc for BIG').first().fill('bc');
    await page.getByPlaceholder('0.00').first().fill('0.001');
    await page.getByPlaceholder('L1 address on order chain').first().fill('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');
    await expect(page.getByText('Pay L1 Chain').last()).toBeAttached();
  });

  test('can fill Pay Back form', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    await page.getByText('Pay Back L1→L0').click();
    await page.waitForTimeout(500);
    await page.getByPlaceholder('e.g. bc for BIG').first().fill('bc');
    await page.getByPlaceholder('0.00').first().fill('0.001');
    await page.getByPlaceholder('L0 address').first().fill('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');
    await expect(page.getByText('Pay Back to L0').last()).toBeAttached();
  });

  test('L1 chain chips appear when chains configured', async ({ page }) => {
    test.skip(!process.env.E2E_SERVER_URL, 'E2E_SERVER_URL not set');
    await ensureWallet(page);
    await openL1Test(page);
    await page.waitForTimeout(1000);
    const chips = page.locator('[data-testid^="l1-chain-chip-"]');
    const count = await chips.count();
    if (count > 0) {
      await chips.first().click();
      await page.waitForTimeout(500);
    }
  });
});
