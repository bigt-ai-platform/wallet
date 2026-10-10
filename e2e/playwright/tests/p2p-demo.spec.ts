import { test, expect, Page, Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { waitForApp, configureServerUrl, goToKeys, clickTab } from '../helpers';

/**
 * P2P demo guide — a REAL e2e test that both asserts the flow and renders the
 * committed guide screenshots (docs/p2p-demo/assets/screenshots).
 *
 * Unlike e2e/capture-p2p-guide.mjs (mock engine, no chain), this runs the
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
 * Fiat verification is the engine's `verify` transition (driven by the engine
 * key here), because a real PayPal webhook cannot be produced in the e2e; the
 * fiat rail itself is out of scope for this chain test.
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

async function refresh(page: Page) {
  await el(page, 'p2p-refresh').click().catch(() => {});
  await page.waitForTimeout(1200);
}

/** A CONFIRMED tx paying `address`, found via the node's address index. */
async function waitConfirmedByAddress(request: any, address: string) {
  for (let i = 0; i < 90; i++) {
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
    const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
    const genesisWallet = sdk.Wallet.fromKeysURL(params, [genesisKey], E2E_SERVER_URL);
    genesisWallet.setServerURL(E2E_SERVER_URL);
    const fundTx = await genesisWallet.payToScript(
      null,
      sdk.Coin.valueOf(GIVE_UNITS),
      null,
      vault.redeemScript,
    );
    const escrowTxHash = fundTx.getHash().toString();
    console.log('escrow funded:', escrowTxHash, '→', escrowAddress);
    const escrowTx = await waitConfirmedByAddress(request, escrowAddress);
    expect(escrowTx, 'escrow funding did not confirm').not.toBeNull();
    await assertEvidence(request, escrowTx.txHash, escrowAddress);
    // The order's giveToken must equal what the engine normalizes from the UTXO.
    const giveToken = await resolveToken(request, escrowTxHash, escrowAddress);

    // ── 2. seller lists, buyer matches (UI) ─────────────────────────────────
    const seller = await newWallet(browser, sellerKey, request);
    const buyer = await newWallet(browser, buyerKey, request);
    try {
      await clickTab(seller.page, 'P2P');
      await el(seller.page, 'p2p-give-token').fill(giveToken);
      await el(seller.page, 'p2p-give-amount').fill(GIVE_UNITS.toString());
      await el(seller.page, 'p2p-want-amount').fill('10');
      await el(seller.page, 'p2p-want-currency').fill('USD');
      await el(seller.page, 'p2p-rail-paypal').click();
      await el(seller.page, 'p2p-create').click();
      await seller.page.waitForTimeout(1500);
      await el(seller.page, 'p2p-tab-open').click();
      await refresh(seller.page);
      await shot(seller.page, 'p2p-01-order-en.png');

      await clickTab(buyer.page, 'P2P');
      await el(buyer.page, 'p2p-order-0').waitFor({ timeout: 20000 });
      await el(buyer.page, 'p2p-buy-0').click();
      await el(buyer.page, 'p2p-buy-recv').fill(receiveAddress);
      await el(buyer.page, 'p2p-buy-paypal').fill('buyer@example.com');
      await el(buyer.page, 'p2p-buy-email').fill('buyer@example.com');
      await el(buyer.page, 'p2p-buy-confirm').click();
      await waitStatus(buyer.page, 'MATCHED');
      await shot(buyer.page, 'p2p-03-match-en.png');
      await shot(buyer.page, 'p2p-04-matched-en.png');

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
      await shot(seller.page, 'p2p-05-escrow-locked-en.png');

      // ── 4. buyer reports the fiat payment ─────────────────────────────────
      await refresh(buyer.page);
      await waitStatus(buyer.page, 'ESCROW_LOCKED');
      await shot(buyer.page, 'p2p-06-buyer-locked-en.png');
      await el(buyer.page, 'p2p-swap-0-pay').click();
      await waitStatus(buyer.page, 'PAYMENT_PENDING');
      await shot(buyer.page, 'p2p-07-payment-pending-en.png');

      // ── 5. engine verifies (stand-in for the PayPal webhook) ──────────────
      const swapId = (await el(buyer.page, 'p2p-swap-0').textContent())!.match(/swap-[0-9a-f]{16}/)![0];
      const verified = await engineTransition(ENGINE_URL, engineKey, engineDid, { swapId, action: 'verify' });
      expect(verified.status).toBe('PAYMENT_VERIFIED');
      await refresh(buyer.page);
      await waitStatus(buyer.page, 'PAYMENT_VERIFIED');
      await shot(buyer.page, 'p2p-08-payment-verified-en.png');

      // ── 6. the escrow hook releases with a real spend to the buyer ────────
      const releaseTx = await waitConfirmedByAddress(request, receiveAddress);
      expect(releaseTx, 'escrow release did not confirm on L0').not.toBeNull();
      await assertEvidence(request, releaseTx.txHash, receiveAddress);
      await refresh(buyer.page);
      await waitStatus(buyer.page, 'ESCROW_RELEASED');
      await shot(buyer.page, 'p2p-09-escrow-released-en.png');
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

/** token string the engine normalizes for the funded escrow UTXO (tokensymbol||tokenname||tokenid). */
async function resolveToken(request: any, txHash: string, escrowAddress: string): Promise<string> {
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const hashHex = Buffer.from(sdk.Address.fromBase58(sdk.TestParams.get(), escrowAddress).getHash160()).toString('hex');
  for (let i = 0; i < 30; i++) {
    const res = await request.post(`${E2E_SERVER_URL}getBalances`, { data: [hashHex] });
    const data = await res.json().catch(() => ({}));
    const out = (data.outputs || []).find((o: any) => String(o.hashHex ?? '') === txHash) || (data.outputs || [])[0];
    if (out) {
      const id = String(out.tokenid ?? out.tokenId ?? '');
      const meta = (data.tokennames || {})[id] || {};
      return meta.tokensymbol || meta.tokenname || id;
    }
    await sleep(2000);
  }
  throw new Error('could not resolve escrow token string');
}

/** Engine-key-signed state transition (the same canonical shape the app sends). */
async function engineTransition(
  engineUrl: string,
  engineKey: any,
  engineDid: string,
  fields: Record<string, unknown>,
) {
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const { randomBytes } = await import('crypto');
  const payload = { ...fields, did: engineDid, nonce: randomBytes(8).toString('hex'), timestamp: Date.now() };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const digest = sdk.Sha256Hash.hash(new TextEncoder().encode(canonical));
  const signature = sdk.Utils.HEX.encode(engineKey.sign(sdk.Sha256Hash.wrap(digest)).serialize());
  const res = await fetch(`${engineUrl}/swaps/${fields.swapId}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, signature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`transition ${fields.action} → ${res.status} ${data.error || ''}`);
  return data as { status: string; swapId: string };
}
