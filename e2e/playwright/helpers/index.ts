import { Page, expect } from '@playwright/test';

export async function waitForApp(page: Page, timeout = 20000) {
  await page.goto('/', { waitUntil: 'load', timeout });
  await page.waitForTimeout(3000);
}

export async function getElement(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]`);
}

export async function clickTab(page: Page, label: string) {
  // Navigation is the sidebar (the bottom bar only carries Menu/Pay/Spot/Home
  // shortcuts): works on both mobile (drawer) and desktop (persistent) and
  // preserves in-memory state (e.g. an unlocked wallet). Scope the click to the
  // sidebar: the mobile bottom bar repeats some labels (Payment/Spot/Home) and
  // sits behind the open drawer, so an unscoped `.first()` would hit the bar.
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.waitForTimeout(400);
  }
  const sidebar = page.getByTestId('sidebar');
  const scope = (await sidebar.count()) > 0 ? sidebar : page;
  await scope.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(1500);
}

// The Payment (send) and Keys (wallet management) screens are no longer tabs —
// they live at their own routes reachable through the sidebar. Navigate via the
// sidebar (client-side) instead of direct /home/* URLs: the e2e web server
// (http-server) has no SPA history fallback, so a full navigation to /home/keys
// or /home/payment 404s).
export async function goToPayment(page: Page) {
  await clickTab(page, 'Payment');
}

export async function goToKeys(page: Page) {
  await clickTab(page, 'Keys');
}

/** The manual Server URL / L1 chain URL fields are shown only when server
 *  auto-selection is OFF (discovery is the default). */
export async function disableAutoDiscover(page: Page) {
  const on = await page.evaluate(
    () => localStorage.getItem('settings.autoDiscover') !== 'false',
  );
  if (on) {
    await page.locator('[data-testid="autodiscover-toggle"]').click();
    await page.waitForTimeout(500);
  }
}

export async function configureServerUrl(page: Page, serverUrl: string, l1Url?: string) {
  await clickTab(page, 'Settings');
  // The local e2e infra is testnet (m…/n… addresses), but the exported web
  // build defaults to mainnet params — Address.fromBase58 then rejects
  // testnet addresses, so sends die before submitTransaction (the resulting
  // window.alert is auto-accepted, failing silently). Enable testnet first:
  // setTestnet() resets the L1 chain list, so it must precede URL edits.
  const testnetOn = await page.evaluate(
    () => localStorage.getItem('settings.useTestnet') === 'true',
  );
  if (!testnetOn) {
    // The Testnet switch is intentionally hidden from Settings. The e2e build
    // exposes a narrow test hook (EXPO_PUBLIC_E2E_ALLOW_TESTNET); fall back to
    // storage + reload for older builds that predate the hook.
    const switched = await page.evaluate(() => {
      const fn = (globalThis as { __bigtangleSetTestnet?: (value: boolean) => void })
        .__bigtangleSetTestnet;
      if (typeof fn !== 'function') return false;
      fn(true);
      return true;
    });
    if (!switched) {
      await page.evaluate(() => localStorage.setItem('settings.useTestnet', 'true'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(3000);
      await clickTab(page, 'Settings');
    }
    await page.waitForTimeout(800);
  }
  // Manual URL fields only render when auto-selection is off.
  await disableAutoDiscover(page);
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

/**
 * Create a fresh client-side wallet and leave it unlocked. No infra needed —
 * keys are generated and stored locally; this is enough to exercise screens
 * that only require an unlocked wallet (e.g. form validation).
 */
export async function createWallet(page: Page, password: string) {
  await page.addInitScript(() => {
    try {
      delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    } catch {
      /* ignore */
    }
  });
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await goToKeys(page);
  await page.getByText('Create New Wallet').click();
  await expect(page.getByText('New Wallet Created!')).toBeAttached({ timeout: 10000 });
  await page.getByText('Save with Password').click();
  await expect(page.getByText('Set Wallet Password')).toBeAttached({ timeout: 5000 });
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/e2e-wallet-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
}

/**
 * Import a known private key into the wallet store and unlock it. Used by the
 * specs that need a specific (funded/authorized) key rather than a fresh one.
 */
export async function importAndUnlock(page: Page, privKeyHex: string, password: string) {
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await goToKeys(page);
  await page.getByText('Import Private Key').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter private key (hex or WIF)').fill(privKeyHex);
  await page.getByText('Import Key').click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.getByText('Save Wallet').click();
  const d = await dl;
  if (d) await d.saveAs(`/tmp/e2e-wallet-${Date.now()}.json`);
  await page.waitForTimeout(1500);
  const done = page.getByText('Done').first();
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(500);
}

/**
 * Point a configured L1 chain (by its chainId, e.g. `prediction`) at `url`
 * through the Settings screen. The chain rows only render once auto-discovery
 * is off (like the manual L0 URL field); the web build bakes prod defaults, so
 * an e2e must retarget the prediction chain at the local L1P before its list
 * can load. Returns false when no such chain row exists.
 */
export async function setL1ChainUrl(page: Page, chainId: string, url: string): Promise<boolean> {
  await clickTab(page, 'Settings');
  await disableAutoDiscover(page);
  const rows = page.locator('[data-testid^="l1-chain-row-"]');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    // field order per row: name | chainId | url
    const id = (await row.locator('input').nth(1).inputValue().catch(() => '')).trim();
    if (id !== chainId) continue;
    const urlInput = row.locator('input[placeholder="https://..."]');
    await urlInput.fill('');
    await urlInput.fill(url);
    await page.waitForTimeout(600); // onChangeUrl auto-saves
    return true;
  }
  return false;
}
