import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp, configureServerUrl, goToKeys, goToPayment, fundFromGenesisWallet } from '../helpers';

const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const PASSWORD = 'TestPass123!';

// P2P settlement wallet legs (tests/demo/p2p-settlement/p2p-settlement.md):
// the two on-chain claims the settlement engine verifies — the seller paying
// the escrow address (ESCROW_LOCKED) and the escrow paying the buyer's
// receive address (ESCROW_RELEASED). Both legs must land CONFIRMED on L0 with
// the exact expected recipient, which is what bigtai's chain evidence gate
// (P2P_CHAIN_VERIFY=1) and e2etest.sh's verify_p2p_legs re-check.
// The release leg spends from the funding wallet here because the e2e controls
// only that key; in production the escrow wallet itself pays the buyer.
const HANDOFF = path.join(process.cwd(), 'test-results', 'p2p-settlement.json');

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

async function sendPayment(page: Page, recipient: string, amount: string) {
  await goToPayment(page);
  await page.waitForTimeout(3000);
  await page.getByPlaceholder('Recipient').fill(recipient);
  await page.getByPlaceholder('0.00').first().fill(amount);
  // window.confirm (web confirm dialog) — auto-accept so the send proceeds;
  // an showAlert() error also lands here, so log the message instead of
  // swallowing it silently.
  page.on('dialog', (d) => {
    console.log(`[dialog:${d.type()}] ${d.message()}`);
    return d.accept().catch(() => {});
  });
  const submitReq = page
    .waitForRequest(
      (req) => req.url().includes(E2E_SERVER_URL) && req.url().includes('submitTransaction'),
      { timeout: 30000 },
    )
    .catch(() => null);
  await page.locator('text=Send Payment').last().click();
  expect(await submitReq).not.toBeNull();
}

/** The txstatus table keys records by the transaction's first output (the
 *  recipient), so poll the expected address until a CONFIRMED tx appears. */
async function waitConfirmedByAddress(request: any, address: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await request.post(`${E2E_SERVER_URL}getTransactionsStatusByAddress`, {
      data: { address },
    });
    const data = await res.json();
    const tx = (data.transactions || []).find((t: any) => t.status === 'CONFIRMED');
    if (tx) return tx;
  }
  return null;
}

/** Exactly what the settlement engine's evidence gate asks for: a CONFIRMED
 *  transaction paying the expected address (getTransactionStatus). */
async function assertEvidence(request: any, txHash: string, expectedAddress: string) {
  const res = await request.post(`${E2E_SERVER_URL}getTransactionStatus`, {
    data: { txHash },
  });
  const data = await res.json();
  expect(data.status).toBe('CONFIRMED');
  if (data.address) expect(data.address).toBe(expectedAddress);
  return data;
}

test.describe('P2P Settlement', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
    if (HAS_SERVER) {
      await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
    }
  });

  test('escrow lock and release legs confirm on-chain', async ({ page, request }) => {
    test.setTimeout(360000);
    test.skip(!HAS_SERVER, 'E2E_SERVER_URL not set');

    const { PQKey, Address, TestParams, Wallet } = await import(
      '../../../packages/bigtangle-ts/dist/index.js'
    );

    const sellerKey = PQKey.createNew();
    const sellerAddress = Address.fromKey(TestParams.get(), sellerKey).toString();
    // escrow (engine-controlled in production) and buyer receive addresses
    const escrowAddress = Address.fromKey(TestParams.get(), PQKey.createNew()).toString();
    const buyerAddress = Address.fromKey(TestParams.get(), PQKey.createNew()).toString();
    console.log('seller', sellerAddress, '\nescrow', escrowAddress, '\nbuyer', buyerAddress);

    await fundFromGenesisWallet(E2E_SERVER_URL, [sellerKey], BigInt(10000000000));

    await goToKeys(page);
    await importKey(page, sellerKey.getPrivateKeyHex());
    await saveWallet(page, PASSWORD);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
    await page.getByText('Unlock Wallet').click();
    await page.waitForTimeout(2000);

    const sellerWallet = Wallet.fromKeysURL(TestParams.get(), [sellerKey], E2E_SERVER_URL);
    let funded = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cands = await sellerWallet.calculateAllSpendCandidates(null, false);
      if (
        cands.some(
          (c: any) =>
            c.getUTXO()?.getTokenId() === 'bc' && c.getUTXO()?.isConfirmed(),
        )
      ) {
        funded = true;
        break;
      }
    }
    expect(funded).toBe(true);

    // 1. escrow lock: seller pays the escrow address
    await sendPayment(page, escrowAddress, '0.001');
    const escrowTx = await waitConfirmedByAddress(request, escrowAddress);
    expect(escrowTx).not.toBeNull();
    await assertEvidence(request, escrowTx.txHash, escrowAddress);
    console.log('escrow leg confirmed:', escrowTx.txHash);

    // change from leg 1 must be spendable before the release leg
    let changeReady = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cands = await sellerWallet.calculateAllSpendCandidates(null, false);
      if (
        cands.some(
          (c: any) =>
            c.getUTXO()?.getTokenId() === 'bc' && c.getUTXO()?.isConfirmed(),
        )
      ) {
        changeReady = true;
        break;
      }
    }
    expect(changeReady).toBe(true);

    // 2. release: escrow pays the buyer's receive address
    await sendPayment(page, buyerAddress, '0.001');
    const releaseTx = await waitConfirmedByAddress(request, buyerAddress);
    expect(releaseTx).not.toBeNull();
    await assertEvidence(request, releaseTx.txHash, buyerAddress);
    console.log('release leg confirmed:', releaseTx.txHash);

    // hand both legs to e2etest.sh (verify_p2p_legs re-checks them on L0)
    fs.mkdirSync(path.dirname(HANDOFF), { recursive: true });
    await fs.promises.writeFile(
      HANDOFF,
      JSON.stringify(
        {
          escrow: { txHash: escrowTx.txHash, status: escrowTx.status, address: escrowAddress },
          release: { txHash: releaseTx.txHash, status: releaseTx.status, address: buyerAddress },
        },
        null,
        2,
      ),
    );
    console.log('p2p settlement handoff written');
  });
});
