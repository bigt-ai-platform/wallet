import { test, expect, type Page } from '@playwright/test';
import { startEthRpcMock } from '../../eth-rpc-mock.mjs';

/**
 * Ethereum deposit / withdraw (docs/ethereum.md).
 *
 * A plain EC wallet (the well-known key `0x4c08…`, whose Bigtangle mainnet
 * address is `1FB3WS…`) and a local JSON-RPC mock drive every flow, so no
 * chain, provider or funds are involved. The mock captures the broadcast raw
 * transactions; the specs assert they are well-formed type-2 payloads signed
 * by the wallet's Ethereum address.
 */

type Mock = {
  url: string;
  sent: Array<{ raw: string }>;
  close: () => Promise<void>;
};

const startMock = startEthRpcMock as unknown as (port?: number) => Promise<Mock>;

const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const BTC_ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';
const ETH_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const RECIPIENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const USDT_CONTRACT = 'dac17f958d2ee523a2206206994597c13d831ec7';
const CUSTOM_TOKEN = '0x1111111111111111111111111111111111111111';
const DEPOSIT_TARGET = '0x2222222222222222222222222222222222222222';

let mock: Mock;

test.beforeEach(async () => {
  mock = await startMock(0);
});

test.afterEach(async () => {
  await mock.close();
});

/** Plain EC wallet (unlocked on boot) + an explicit RPC endpoint. */
async function injectEcWallet(page: Page, rpcUrl = mock.url) {
  await page.addInitScript(
    ([key, pub, address, rpc]) => {
      const wallet = {
        keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }],
      };
      localStorage.setItem('device.walletEncryptedContent', JSON.stringify(wallet));
      localStorage.setItem('device.walletAddress', address);
      localStorage.setItem(
        'eth.settings',
        JSON.stringify({ network: 'mainnet', rpcUrl: rpc, indexUrl: rpc })
      );
    },
    [EC_KEY, EC_PUB, BTC_ADDRESS, rpcUrl] as const
  );
}

/**
 * The wallet save flow offers a file download on the web. `showSaveFilePicker`
 * is desktop-only and cancels in headless Chromium, which aborts the save
 * ("Save cancelled"); removing it lets the anchor-download fallback run.
 */
async function disableFilePicker(page: Page) {
  await page.addInitScript(() => {
    try {
      delete (globalThis as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    } catch {
      /* ignore */
    }
  });
}

/** Open the drawer and go to the Ethereum screen (client-side navigation). */
async function gotoEthereum(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Ethereum', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByTestId('eth-screen')).toBeAttached({ timeout: 15000 });
}

/** Open the drawer and go to Deposit (client-side navigation). */
async function gotoDeposit(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Deposit', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByTestId('deposit-screen')).toBeAttached({ timeout: 15000 });
}

/** Open the drawer and go to Withdraw (client-side navigation). */
async function gotoWithdraw(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Withdraw', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByTestId('withdraw-screen')).toBeAttached({ timeout: 15000 });
}

/** Open the drawer and go to Keys (client-side navigation). */
async function gotoKeys(page: Page) {
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const item = page.getByTestId('sidebar').getByRole('button', { name: 'Keys', exact: true });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(page.getByText('Manage Keys').first()).toBeAttached({ timeout: 10000 });
}

test.describe('Ethereum deposit / withdraw', () => {
  test('shows balances, a deposit QR, deposit history and signs an ERC-20 withdrawal', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);

    await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 15000 });
    await expect(page.getByTestId('eth-asset-ETH')).toContainText('1');
    await expect(page.getByTestId('eth-asset-USDT')).toContainText('2.5');

    // Deposit history: native transfer from the address index + the ERC-20 log.
    await expect(page.getByTestId('eth-deposits')).toContainText('+1 USDT', { timeout: 20000 });
    await expect(page.getByTestId('eth-deposits')).toContainText('+0.5 ETH', { timeout: 20000 });
    await expect(page.getByTestId('eth-deposit-row')).toHaveCount(2);

    // Deposit: address card + QR + network warning.
    await page.getByTestId('eth-deposit-ETH').click();
    await expect(page.getByTestId('eth-deposit-card')).toBeAttached();
    await expect(page.getByTestId('eth-deposit-address')).toHaveText(ETH_ADDRESS);
    await expect(page.getByTestId('eth-deposit-card')).toContainText('Send only ETH on Ethereum');
    expect(await page.locator('[data-testid="eth-deposit-card"] svg').count()).toBeGreaterThan(0);

    // Withdraw 1.5 USDT with the Fast preset.
    await page.getByTestId('eth-withdraw-USDT').click();
    await page.getByTestId('eth-withdraw-to').fill(RECIPIENT);
    await page.getByTestId('eth-withdraw-amount').fill('1.5');
    await expect(page.getByTestId('eth-fee')).toContainText('Network fee up to', { timeout: 15000 });
    const standardFee = await page.getByTestId('eth-fee').innerText();
    await expect(page.getByTestId('eth-gas-presets')).toContainText('Slow');
    await page.getByTestId('eth-gas-fast').click();
    await expect(page.getByTestId('eth-fee')).not.toHaveText(standardFee, { timeout: 15000 });

    await page.getByTestId('eth-withdraw-submit').click();
    await expect(page.getByTestId('eth-screen')).toContainText('Transaction sent', { timeout: 20000 });
    await expect(page.getByTestId('eth-screen')).toContainText('Confirmed', { timeout: 20000 });

    expect(mock.sent).toHaveLength(1);
    const raw = mock.sent[0].raw.toLowerCase();
    expect(raw.startsWith('0x02')).toBe(true);
    // ERC-20 transfer to the USDT contract.
    expect(raw).toContain(USDT_CONTRACT);
    expect(raw).toContain('a9059cbb');
  });

  test('signs a native ETH withdrawal with the amount in value', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);
    await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 15000 });

    await page.getByTestId('eth-withdraw-ETH').click();
    await page.getByTestId('eth-withdraw-to').fill(RECIPIENT);
    await page.getByTestId('eth-withdraw-amount').fill('0.01');
    await expect(page.getByTestId('eth-fee')).toContainText('Network fee up to', { timeout: 15000 });
    await page.getByTestId('eth-withdraw-submit').click();
    await expect(page.getByTestId('eth-screen')).toContainText('Transaction sent', { timeout: 20000 });

    expect(mock.sent).toHaveLength(1);
    const raw = mock.sent[0].raw.toLowerCase();
    expect(raw.startsWith('0x02')).toBe(true);
    // Recipient and 0.01 ETH = 10^16 wei = 0x2386f26fc10000 appear verbatim
    // in the RLP payload, and there is no ERC-20 calldata.
    expect(raw).toContain(RECIPIENT.slice(2).toLowerCase());
    expect(raw).toContain('2386f26fc10000');
    expect(raw).not.toContain('a9059cbb');
  });

  test('rejects an invalid address, an empty amount and an over-balance amount', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);
    await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 15000 });

    await page.getByTestId('eth-withdraw-ETH').click();

    // Invalid (too short) address.
    await page.getByTestId('eth-withdraw-to').fill('0x1234');
    await page.getByTestId('eth-withdraw-amount').fill('0.1');
    await page.getByTestId('eth-withdraw-submit').click();
    await expect(page.getByTestId('eth-error')).toContainText('valid Ethereum address');

    // Empty amount.
    await page.getByTestId('eth-withdraw-to').fill(RECIPIENT);
    await page.getByTestId('eth-withdraw-amount').fill('');
    await page.getByTestId('eth-withdraw-submit').click();
    await expect(page.getByTestId('eth-error')).toContainText('valid amount');

    // More than the 1 ETH balance.
    await page.getByTestId('eth-withdraw-amount').fill('5');
    await page.getByTestId('eth-withdraw-submit').click();
    await expect(page.getByTestId('eth-error')).toContainText('Insufficient balance');

    expect(mock.sent).toHaveLength(0);
  });

  test('adds a custom ERC-20 token by contract and keeps it across reloads', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);
    await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 15000 });

    await page.getByTestId('eth-add-token').click();
    await page.getByTestId('eth-token-address').fill(CUSTOM_TOKEN);
    await page.getByTestId('eth-token-add').click();
    await expect(page.getByTestId('eth-asset-TESTX')).toBeAttached({ timeout: 15000 });

    // A reload on /ethereum would 404 (the e2e web server has no SPA
    // fallback); boot from / and navigate again — the token list is persisted.
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);
    await expect(page.getByTestId('eth-asset-TESTX')).toBeAttached({ timeout: 15000 });
  });

  test('reports a missing RPC proxy as not configured', async ({ page }) => {
    // `/nope` is answered by the static server with 404 (or the SPA fallback),
    // never JSON-RPC — the screen must say "not configured", not a parse error.
    await injectEcWallet(page, '/nope');
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoEthereum(page);
    await expect(page.getByTestId('eth-error')).toContainText('No Ethereum RPC endpoint configured', {
      timeout: 20000,
    });
  });
});

test.describe('USDT deposit (exchange style)', () => {
  test('coin -> network -> per-user address, pays the issuer and tracks the deposit', async ({ page }) => {
    await injectEcWallet(page);
    await page.addInitScript(
      ([api]) => {
        localStorage.setItem(
          'eth.bridge',
          JSON.stringify({ apiUrl: api, issuerAddress: '', minUsdt: '1' })
        );
      },
      [mock.url] as const
    );
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoDeposit(page);

    // Step 1: coin, step 2: network (Binance-style pickers).
    await page.getByTestId('deposit-coin-USDT').click();
    await page.getByTestId('deposit-network-ethereum').click();

    // Step 3: the user's own address from the issuer API, warnings + min.
    await expect(page.getByTestId('deposit-address')).toHaveText(DEPOSIT_TARGET, { timeout: 15000 });
    await expect(page.getByTestId('deposit-warning')).toContainText('Ethereum (ERC-20)');
    await expect(page.getByTestId('deposit-address-card')).toContainText('personal deposit address');
    await expect(page.getByTestId('deposit-address-card')).toContainText('Minimum deposit: 1');
    expect(await page.locator('[data-testid="deposit-address-card"] svg').count()).toBeGreaterThan(0);

    // Below the minimum is rejected without broadcasting.
    await page.getByTestId('deposit-amount').fill('0.5');
    await page.getByTestId('deposit-submit').click();
    await expect(page.getByTestId('deposit-error')).toContainText('Minimum deposit is 1');
    expect(mock.sent).toHaveLength(0);

    // Pay the deposit from this wallet: an ERC-20 transfer to the issuer
    // address, tracked as a pending deposit row.
    await page.getByTestId('deposit-amount').fill('2');
    await page.getByTestId('deposit-submit').click();
    await expect(page.getByTestId('deposit-notice')).toContainText('Deposit sent', { timeout: 20000 });
    await expect(page.getByTestId('deposit-history')).toContainText('+2 USDT');
    await expect(page.getByTestId('deposit-history')).toContainText('Pending');

    expect(mock.sent).toHaveLength(1);
    const raw = mock.sent[0].raw.toLowerCase();
    expect(raw.startsWith('0x02')).toBe(true);
    expect(raw).toContain(USDT_CONTRACT);
    expect(raw).toContain('2222222222222222222222222222222222222222');
    expect(raw).toContain('a9059cbb');
  });
});

test.describe('Withdraw (exchange style)', () => {
  test('asset -> network -> address/amount signs an ERC-20 transfer', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoWithdraw(page);

    await page.getByTestId('withdraw-asset-USDT').click();
    await page.getByTestId('withdraw-network-ethereum').click();
    await page.getByTestId('withdraw-to').fill(RECIPIENT);
    await page.getByTestId('withdraw-amount').fill('1.5');
    await expect(page.getByTestId('withdraw-fee')).toContainText('Network fee up to', { timeout: 15000 });
    await expect(page.getByTestId('withdraw-gas-presets')).toContainText('Slow');
    await page.getByTestId('withdraw-submit').click();

    await expect(page.getByTestId('withdraw-notice')).toContainText('Transaction sent', { timeout: 20000 });
    await expect(page.getByTestId('withdraw-history')).toContainText('Confirmed', { timeout: 20000 });

    expect(mock.sent).toHaveLength(1);
    const raw = mock.sent[0].raw.toLowerCase();
    expect(raw.startsWith('0x02')).toBe(true);
    expect(raw).toContain(USDT_CONTRACT);
    expect(raw).toContain('a9059cbb');
  });

  test('refuses to send to the wallet own address', async ({ page }) => {
    await injectEcWallet(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoWithdraw(page);
    await page.getByTestId('withdraw-asset-USDT').click();
    await page.getByTestId('withdraw-network-ethereum').click();
    await page.getByTestId('withdraw-to').fill(ETH_ADDRESS);
    await page.getByTestId('withdraw-amount').fill('1');
    // No fee estimate is possible for the wallet's own address (the builder
    // rejects it), so submit straight away and assert the rejection.
    await page.getByTestId('withdraw-submit').click();
    await expect(page.getByTestId('withdraw-error')).toContainText('own address', { timeout: 20000 });
    expect(mock.sent).toHaveLength(0);
  });
});

test.describe('Ethereum wallet gating', () => {
  test('a wallet created by the app (PQ by default) shows the EC requirement', async ({ page }) => {
    await disableFilePicker(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoKeys(page);

    // Default create flow makes a post-quantum wallet.
    await page.getByText('Create New Wallet').first().click();
    await page.getByText('Save with Password').first().click();
    const pw = page.locator('input[type="password"]');
    await pw.nth(0).fill('TestPassword123!');
    await pw.nth(1).fill('TestPassword123!');
    await page.getByText('Save Wallet').first().click();
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({ timeout: 30000 });
    await page.getByText('Done').first().click();

    await gotoEthereum(page);
    await expect(page.getByTestId('eth-ec-gate')).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId('eth-ec-gate')).toContainText('post-quantum');
    await expect(page.getByTestId('eth-address')).toHaveCount(0);
  });

  test('creates a legacy EC wallet and derives an Ethereum address', async ({ page }) => {
    await disableFilePicker(page);
    await page.goto('/');
    await page.waitForTimeout(1500);
    await gotoKeys(page);

    await page.getByTestId('keys-create-ec').click();
    await page.getByText('Save with Password').first().click();
    const pw = page.locator('input[type="password"]');
    await pw.nth(0).fill('TestPassword123!');
    await pw.nth(1).fill('TestPassword123!');
    await page.getByText('Save Wallet').first().click();
    await expect(page.getByText('Wallet Saved Successfully!').first()).toBeAttached({ timeout: 30000 });
    await page.getByText('Done').first().click();

    await gotoEthereum(page);
    await expect(page.getByTestId('eth-ec-gate')).toHaveCount(0);
    await expect(page.getByTestId('eth-address')).toHaveText(/^0x[0-9a-fA-F]{40}$/, { timeout: 15000 });
  });
});
