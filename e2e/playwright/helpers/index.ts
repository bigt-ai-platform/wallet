import { Page } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/', { waitUntil: 'load', timeout });
  await page.waitForTimeout(3000);
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  // The bottom tab bar is only visible on tab screens, and several screens are
  // no longer tabs at all — so navigate through the sidebar, which works on
  // both mobile (drawer) and desktop (persistent) and preserves in-memory
  // state (e.g. an unlocked wallet).
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

// The Payment (send) and Keys (wallet management) screens are no longer tabs —
// they live at their own routes reachable through the sidebar. Navigate via the
// sidebar (client-side) instead of direct /home/* URLs: the e2e web server
// (http-server) has no SPA history fallback, so a full navigation to /home/keys
// or /home/payment 404s (same reason chart.spec navigates to Chart via the
// sidebar).
export async function goToPayment(page: Page) {
  await clickTab(page, 'Payment');
}

export async function goToKeys(page: Page) {
  await clickTab(page, 'Keys');
}

export async function configureServerUrl(page: Page, serverUrl: string, l1Url?: string) {
  await clickTab(page, 'Settings');
  const input = page.locator('[data-testid="server-url-input"]');
  await input.fill('');
  await input.fill(serverUrl);
  if (l1Url) {
    // Update the FIRST L1 chain URL input. The server-url-input also has
    // placeholder "https://...", so skip it (index 0) and use index 1.
    const urlInputs = page.locator('input[placeholder="https://..."]');
    const count = await urlInputs.count();
    if (count > 1) {
      await urlInputs.nth(1).fill('');
      await urlInputs.nth(1).fill(l1Url);
    }
  }
  await page.locator('text=Save').first().click();
  await page.waitForTimeout(1000);
}

export const TEST_WALLET = {
  password: 'TestPassword123!',
  privateKey: '9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891',
  address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
};

/**
 * Fund the given keys with real on-chain BIG from the L0/L1 genesis wallet
 * (ML-DSA-87 seed 0x01, pre-funded by the genesis CSV bootstrap).
 *
 * The Java server removed the fundAddresses faucet (commit fa3935f7f —
 * "bootstrap wallets via genesis CSV"), so e2e tests must fund beneficiaries
 * the way the Java remote tests do (RemoteTestBase.payBigTo): pay real BIG
 * from the genesis wallet and wait for it to confirm.
 */
export async function fundFromGenesisWallet(
  serverUrl: string,
  keys: any[],
  amount: bigint,
): Promise<void> {
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const bcToken = sdk.NetworkParameters.BIGTANGLE_TOKENID_STRING;
  const genesisKey = sdk.PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
  const wallet = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [genesisKey], serverUrl);
  wallet.setServerURL(serverUrl);

  const giveMoney = new Map<string, bigint>();
  for (const k of keys) {
    giveMoney.set(sdk.Address.fromKey(sdk.TestParams.get(), k).toString(), amount);
  }
  const coinList = await wallet.calculateAllSpendCandidates(null, false);
  const tx = await wallet.payMoneyToECKeyList(
    null,
    giveMoney,
    new Uint8Array(sdk.Utils.HEX.decode(bcToken)),
    'e2e-fund',
    coinList,
  );
  if (!tx) throw new Error('Genesis wallet funding produced no transaction');
}

/** Wait until `key` holds a confirmed, spendable BIG UTXO on `serverUrl`. */
export async function waitForConfirmedBc(key: any, serverUrl: string, tokenid = 'bc'): Promise<void> {
  const sdk = await import('../../../packages/bigtangle-ts/dist/index.js');
  const w = sdk.Wallet.fromKeysURL(sdk.TestParams.get(), [key], serverUrl);
  for (let i = 0; i < 60; i++) {
    const cands = await w.calculateAllSpendCandidates(null, false);
    const hit = cands.find(
      (c: any) => c.getUTXO()?.getTokenId() === tokenid
        && c.getUTXO()?.getValue()?.getValue() > BigInt(0),
    );
    if (hit) return;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for confirmed ${tokenid} balance on ${serverUrl}`);
}
