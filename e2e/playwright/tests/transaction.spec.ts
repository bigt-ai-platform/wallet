import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp, clickTab, configureServerUrl, goToKeys, goToPayment, fundFromGenesisWallet } from '../helpers';

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
    test.setTimeout(360000);
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

    // 2. Fund Alice with real on-chain BC from the genesis wallet (the Java
    //    server removed the fundAddresses faucet — wallets are bootstrapped via
    //    the genesis CSV, so tests pay beneficiaries like RemoteTestBase.payBigTo).
    await fundFromGenesisWallet(E2E_SERVER_URL, [aliceKey], BigInt(10000000000));
    console.log('Funded', aliceAddress);

    // 3. Import Alice key into the app (Keys screen at /home/keys).
    await goToKeys(page);
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
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
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
    await goToPayment(page);
    await page.waitForTimeout(3000);

    await page.getByPlaceholder('Recipient').fill(bobAddress);
    await page.getByPlaceholder('0.00').first().fill('0.001');

    // window.confirm (web confirm dialog) — auto-accept so the send proceeds.
    // Log the message: an error showAlert() also lands here (window.alert),
    // and swallowing it silently hides the real failure.
    page.on('dialog', (d) => {
      console.log(`[dialog:${d.type()}] ${d.message()}`);
      return d.accept().catch(() => {});
    });
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
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
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
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
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
