import { test, expect, Page, Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp, configureServerUrl, goToKeys, goToPayment, clickTab } from '../helpers';

/**
 * P2P demo guide — a REAL e2e test that both asserts the flow and renders the
 * committed guide screenshots (docs/p2p-demo/assets/screenshots).
 *
 * Unlike e2e/capture-p2p-cny.mjs (mock engine, no chain), this runs the
 * wallet's P2pScreen against a p2p-engine wired to the REAL L0 node
 * (`SETTLEMENT_L0_URL`, testnet params) with a real engine escrow key, so the
 * meaningful legs are proved on-chain:
 *
 *   1. a real 2-of-3 P2SH escrow output is funded and CONFIRMED on L0;
 *   2. the engine's `escrow_lock` passes its `verifyChainLock` gate against it
 *      (CONFIRMED + pays the escrow address + holds the order amount);
 *   3. the engine releases the escrow with a real spend (seller presign + the
 *      engine key), CONFIRMED at the buyer's receive address, which the harness
 *      re-checks on L0 (e2etest.sh verify_p2p_escrow).
 *
 * The fiat leg is the CNY flow (seller profile → buyer instructions → buyer
 * proof → seller confirm); the chain test's point is the escrow legs, which
 * are rail-agnostic.
 *
 * Skipped unless the engine env is present (E2E_P2P_ENGINE_URL +
 * SETTLEMENT_ENGINE_PUBKEY + SETTLEMENT_ENGINE_KEY) and an L0 is configured.
 * Wired as `./e2etest.sh p2p-demo`.
 */
const E2E_SERVER_URL = process.env.E2E_SERVER_URL || '';
const E2E_L1_URL = process.env.E2E_L1_URL || '';
const ENGINE_URL = (process.env.E2E_P2P_ENGINE_URL || '').replace(/\/+$/, '');
const ENGINE_PUB = process.env.SETTLEMENT_ENGINE_PUBKEY || '';
const ENGINE_KEY_HEX = process.env.SETTLEMENT_ENGINE_KEY || '';
const HAS_SERVER = !!E2E_SERVER_URL;
const READY = HAS_SERVER && !!ENGINE_URL && !!ENGINE_PUB && !!ENGINE_KEY_HEX;

const PASSWORD = 'P2pRealPass123!';
const GIVE_UNITS = 100000n; // token units the escrow is funded with (integer)
const SHOTS = path.resolve(process.cwd(), '..', 'docs', 'p2p-demo', 'assets', 'screenshots');
const HANDOFF = path.join(process.cwd(), 'test-results', 'p2p-demo.json');

const el = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Step timing: the real-L0 flow is minutes long, so the log must show where the
// time went when a run dies on the test budget.
const T0 = Date.now();
const step = (label: string) => console.log(`  [${Math.round((Date.now() - T0) / 1000)}s] ${label}`);

async function importKeyAndUnlock(page: Page, privKeyHex: string) {
  await goToKeys(page);
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privKeyHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').fill(PASSWORD);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/p2p-real-${Date.now()}.json`);
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1500);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await goToPayment(page);
  await page.getByPlaceholder('Enter wallet password').fill(PASSWORD);
  await page.getByText('Unlock Wallet').click();
  await page.waitForTimeout(2000);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  console.log(`  ✓ ${name}`);
}

async function waitStatus(page: Page, expected: string, id = 'p2p-swap-0-status', ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    const txt = await el(page, id).first().textContent().catch(() => null);
    if (txt === expected) return;
    if (Date.now() - t0 > ms) {
      const notice = await el(page, 'p2p-notice').first().textContent().catch(() => null);
      throw new Error(`timeout: want ${expected}, got ${txt} | notice: ${notice}`);
    }
    await page.waitForTimeout(400);
  }
}

/** Wait for any of `expected` — a CNY swap auto-advances PAYMENT_VERIFIED →
 *  ESCROW_RELEASED → COMPLETED in one settle, so the intermediate states are
 *  transient and a strict equality poll can miss them. */
async function waitStatusAny(page: Page, expected: string[], id = 'p2p-swap-0-status', ms = 90000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const txt = (await el(page, id).first().textContent().catch(() => null)) ?? '';
    if (expected.includes(txt)) return txt;
    if (Date.now() - t0 > ms) {
      const notice = await el(page, 'p2p-notice').first().textContent().catch(() => null);
      throw new Error(`timeout: want one of ${expected.join('|')}, got ${txt} | notice: ${notice}`);
    }
    await refresh(page);
  }
}

async function refresh(page: Page) {
  await el(page, 'p2p-refresh').click().catch(() => {});
  await page.waitForTimeout(1200);
}

/** A CONFIRMED tx paying `address`, found via the node's address index. */
async function waitConfirmedByAddress(request: any, address: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const res = await request.post(`${E2E_SERVER_URL}getTransactionsStatusByAddress`, { data: { address } });
    const data = await res.json().catch(() => ({}));
    const tx = (data.transactions || []).find((t: any) => t.status === 'CONFIRMED');
    if (tx) return tx;
    await sleep(2000);
  }
  return null;
}

async function assertEvidence(request: any, txHash: string, expectedAddress: string) {
  const res = await request.post(`${E2E_SERVER_URL}getTransactionStatus`, { data: { txHash } });
  const data = await res.json();
  expect(data.status).toBe('CONFIRMED');
  if (data.address) expect(data.address).toBe(expectedAddress);
  return data;
}

test.describe('P2P Demo (real L0)', () => {
  test('real 2-of-3 escrow lock + release on L0, capturing the guide screenshots', async ({ browser, request }) => {
    test.setTimeout(20 * 60 * 1000);
    test.skip(!READY, 'needs E2E_SERVER_URL + E2E_P2P_ENGINE_URL + engine key/pubkey');

    const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
    const { didFromPQKey } = await import('did/pq');
    const params = sdk.TestParams.get();

    // ── Keys the spec controls (so it can build the vault and verify legs) ──
    const sellerKey = sdk.PQKey.createNewKey();
    const buyerKey = sdk.PQKey.createNewKey();
    const sellerDid = didFromPQKey(sellerKey);
    const buyerDid = didFromPQKey(buyerKey);
    const receiveAddress = sdk.Address.fromKey(params, buyerKey).toString();
    const engineKey = sdk.PQKey.fromPrivateKeyHex(ENGINE_KEY_HEX);
    // The engine's did:key is derived from the same key (deterministic).
    const engineDid = didFromPQKey(engineKey);

    // Same 2-of-3 vault the engine derives (Escrow sorts keys, so order is moot).
    const vault = sdk.Escrow.twoOfThree({ seller: sellerKey, buyer: buyerKey, engine: sdk.PQKey.fromPrefixedPublicKey(sdk.Utils.HEX.decode(ENGINE_PUB)) });
    const escrowAddress = vault.address(params).toBase58();

    fs.mkdirSync(SHOTS, { recursive: true });
    fs.mkdirSync(path.dirname(HANDOFF), { recursive: true });

    // ── 1. fund the escrow P2SH directly from the L0 genesis wallet ─────────
    // Seed 0x03 (the yuan genesis row, 8 outputs) — NOT 0x01: every other spec
    // funds from 0x01, and while one of its change outputs is still
    // spendPending the single-validator L0 drops the escrow spend. 0x03 is
    // untouched by the harness, so the escrow funding never contends with them.
    const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x03));
    const genesisWallet = sdk.Wallet.fromKeysURL(params, [genesisKey], E2E_SERVER_URL);
    genesisWallet.setServerURL(E2E_SERVER_URL);
    // The single-validator L0 reorgs, so the genesis change output flips
    // spendPending between runs. Wait for a CONFIRMED spendable BIG candidate,
    // then retry the whole funding if the tx never confirms — otherwise the
    // first build races a pending output and the node drops it (UNKNOWN).
    let escrowTx: any = null;
    let escrowTxHash = '';
    for (let attempt = 0; attempt < 3 && !escrowTx; attempt++) {
      for (let i = 0; i < 60; i++) {
        const cands: any[] = await genesisWallet.calculateAllSpendCandidates(null, false).catch(() => []);
        if (cands.some((c) => c.getUTXO()?.getTokenId() === 'bc' && c.getUTXO()?.isConfirmed())) break;
        await sleep(2000);
      }
      const fundTx = await genesisWallet.payToScript(null, sdk.Coin.valueOf(GIVE_UNITS), null, vault.outputScript);
      escrowTxHash = fundTx.getHash().toString();
      console.log(`escrow funded (attempt ${attempt + 1}):`, escrowTxHash, '→', escrowAddress);
      escrowTx = await waitConfirmedByAddress(request, escrowAddress, 45);
    }
    expect(escrowTx, 'escrow funding did not confirm').not.toBeNull();
    await assertEvidence(request, escrowTx.txHash, escrowAddress);
    // The order's giveToken must equal what the engine normalizes from the UTXO.
    const giveToken = await resolveToken(request, escrowTxHash, escrowAddress);

    // ── 2. seller lists, buyer matches (UI) ─────────────────────────────────
    step('escrow funded + token resolved');
    const seller = await newWallet(browser, sellerKey, request);
    const buyer = await newWallet(browser, buyerKey, request);
    step('two wallets imported');
    try {
      await clickTab(seller.page, 'P2P');
      await el(seller.page, 'p2p-give-token').fill(giveToken);
      await el(seller.page, 'p2p-give-amount').fill(GIVE_UNITS.toString());
      await el(seller.page, 'p2p-want-amount').fill('10');
      await el(seller.page, 'p2p-want-currency').fill('CNY');
      await el(seller.page, 'p2p-rail-wechat').click();
      await el(seller.page, 'p2p-create').click();
      await seller.page.waitForTimeout(1500);
      await el(seller.page, 'p2p-tab-open').click();
      await refresh(seller.page);
      await shot(seller.page, 'p2p-real-01-order-en.png');

      await clickTab(buyer.page, 'P2P');
      await el(buyer.page, 'p2p-order-0').waitFor({ timeout: 20000 });
      await el(buyer.page, 'p2p-buy-0').click();
      await el(buyer.page, 'p2p-buy-recv').fill(receiveAddress);
      await el(buyer.page, 'p2p-buy-confirm').click();
      await waitStatus(buyer.page, 'MATCHED');
      await shot(buyer.page, 'p2p-real-03-match-en.png');
      await shot(buyer.page, 'p2p-real-04-matched-en.png');

      // ── 3. seller locks with the REAL funding txHash ──────────────────────
      // The engine caps signed calls per DID (10/60s); pace past the window.
      await sleep(65000);
      await el(seller.page, 'p2p-tab-mine').click();
      await refresh(seller.page);
      await waitStatus(seller.page, 'MATCHED');
      await el(seller.page, 'p2p-swap-0-txhash').fill(escrowTxHash);
      await el(seller.page, 'p2p-swap-0-lock').click();
      // ESCROW_LOCKED is only reachable when verifyChainLock passed on L0.
      await waitStatus(seller.page, 'ESCROW_LOCKED');
      step('ESCROW_LOCKED (engine verifyChainLock passed)');
      await shot(seller.page, 'p2p-real-05-escrow-locked-en.png');

      // ── 4. seller saves a CNY profile, buyer pulls instructions + claims ──
      await el(seller.page, 'p2p-profile-method-wechat').click();
      await el(seller.page, 'p2p-profile-name').fill('Zhang San');
      await el(seller.page, 'p2p-profile-account').fill('wxid_demo');
      await el(seller.page, 'p2p-profile-save').click();
      await sleep(1500);
      await refresh(buyer.page);
      await waitStatus(buyer.page, 'ESCROW_LOCKED');
      await shot(buyer.page, 'p2p-real-06-buyer-locked-en.png');
      await el(buyer.page, 'p2p-swap-0-instructions').click();
      await waitStatus(buyer.page, 'PAYMENT_PENDING');
      step('buyer PAYMENT_PENDING');
      await shot(buyer.page, 'p2p-real-07-payment-pending-en.png');
      await el(buyer.page, 'p2p-swap-0-txid').fill('4200001234567890');
      await el(buyer.page, 'p2p-swap-0-proof').click();
      await waitStatus(buyer.page, 'PAYMENT_CLAIMED');
      step('buyer PAYMENT_CLAIMED');

      // ── 5. seller confirms receipt on their own 流水 ──────────────────────
      await refresh(seller.page);
      await waitStatus(seller.page, 'PAYMENT_CLAIMED');
      await el(seller.page, 'p2p-swap-0-confirm').click();
      step('seller confirm clicked');
      await waitStatusAny(seller.page, ['PAYMENT_VERIFIED', 'ESCROW_RELEASED', 'COMPLETED']);
      step('seller PAYMENT_VERIFIED');
      await refresh(buyer.page);
      await waitStatusAny(buyer.page, ['PAYMENT_VERIFIED', 'ESCROW_RELEASED', 'COMPLETED']);
      await shot(buyer.page, 'p2p-real-08-payment-verified-en.png');

      // ── 6. the escrow hook releases with a real spend to the buyer ────────
      const releaseTx = await waitConfirmedByAddress(request, receiveAddress);
      expect(releaseTx, 'escrow release did not confirm on L0').not.toBeNull();
      await assertEvidence(request, releaseTx.txHash, receiveAddress);
      await refresh(buyer.page);
      // CNY has no fiat payout step, so the engine closes the loop to COMPLETED
      // in the same settle as the on-chain release.
      await waitStatusAny(buyer.page, ['ESCROW_RELEASED', 'COMPLETED']);
      step('ESCROW_RELEASED on L0');
      await shot(buyer.page, 'p2p-real-09-escrow-released-en.png');
      console.log('escrow released:', releaseTx.txHash, '→', receiveAddress);

      await fs.promises.writeFile(
        HANDOFF,
        JSON.stringify(
          {
            escrow: { txHash: escrowTx.txHash, status: escrowTx.status, address: escrowAddress },
            release: { txHash: releaseTx.txHash, status: releaseTx.status, address: receiveAddress },
            engineDid: engineDid,
            sellerDid,
            buyerDid,
          },
          null,
          2,
        ),
      );
    } finally {
      await seller.context.close();
      await buyer.context.close();
    }
  });
});

async function newWallet(browser: Browser, key: any, _request: any) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await waitForApp(page);
  await configureServerUrl(page, E2E_SERVER_URL, E2E_L1_URL);
  await importKeyAndUnlock(page, key.getPrivateKeyHex());
  return { context, page };
}

/**
 * The token string the engine normalizes for the funded escrow UTXO.
 *
 * Uses getOutputsHistory, not getBalances: the escrow is a 2-of-3 P2SH output,
 * and getBalances rebuilds the query address with the P2PKH header
 * (Address.fromHash160) and filters the denormalized outputs.confirmed column —
 * so it never returns a P2SH output sealed in a TRANSFER block.
 * getOutputsHistory matches on `toaddress` and uses the computed
 * OUTPUTS_CONFIRMED (the same lookup the engine's verifyChainLock uses).
 */
async function resolveToken(request: any, txHash: string, escrowAddress: string): Promise<string> {
  for (let i = 0; i < 90; i++) {
    const res = await request.post(`${E2E_SERVER_URL}getOutputsHistory`, {
      data: { fromaddress: '', toaddress: escrowAddress, starttime: null, endtime: null },
    });
    const data = await res.json().catch(() => ({}));
    const outputs: any[] = data.outputs || [];
    const out = outputs.find((o) => String(o.hashHex ?? '') === txHash) || outputs[0];
    if (out) {
      const id = String(out.tokenId ?? out.tokenHex ?? out.tokenid ?? '');
      return id || String(out.value?.tokenHex ?? '');
    }
    await sleep(2000);
  }
  throw new Error('could not resolve escrow token string');
}
