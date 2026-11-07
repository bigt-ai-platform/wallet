import { test, expect } from '@playwright/test';
import { startEthRpcMock } from '../../eth-rpc-mock.mjs';

/**
 * Ethereum deposit / withdraw (docs/ethereum.md).
 *
 * Uses a plain EC wallet (the key `0x4c08…` is a well-known test key whose
 * Bucket address on Bigtangle mainnet is `1FB3WS…`) and a local JSON-RPC mock,
 * so no chain, provider or funds are involved. The mock captures the broadcast
 * raw transaction; the spec asserts it is a type-2 (EIP-1559) payload signed by
 * the wallet's Ethereum address.
 */

const EC_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const EC_PUB = '024e3b81af9c2234cad09d679ce6035ed1392347ce64ce405f5dcd36228a25de6e';
const BTC_ADDRESS = '1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3';
const ETH_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const RECIPIENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

test.describe('Ethereum deposit / withdraw', () => {
  test('shows balances, a deposit address/QR and signs a withdrawal', async ({ page }) => {
    const mock = await startEthRpcMock(0);
    try {
      // A plain (unencrypted) EC wallet is unlocked on boot; the ETH settings
      // point at the mock RPC.
      await page.addInitScript(
        ([key, pub, address, rpc]) => {
          const wallet = {
            keys: [{ address, pubkey: pub, privateKey: key, keyType: 'EC', network: 'Main' }],
          };
          localStorage.setItem('device.walletEncryptedContent', JSON.stringify(wallet));
          localStorage.setItem('device.walletAddress', address);
          localStorage.setItem('eth.settings', JSON.stringify({ network: 'mainnet', rpcUrl: rpc }));
        },
        [EC_KEY, EC_PUB, BTC_ADDRESS, mock.url] as const
      );

      await page.goto('/');
      await page.waitForTimeout(2000);
      // Open the navigation drawer and pick the new Ethereum entry (the e2e web
      // server has no SPA fallback, so `/ethereum` cannot be opened directly).
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      const ethNav = page.getByTestId('sidebar').getByRole('button', { name: 'Ethereum', exact: true });
      await expect(ethNav).toBeVisible({ timeout: 10000 });
      await ethNav.click();
      await expect(page.getByTestId('eth-screen')).toBeAttached({ timeout: 15000 });

      // Account + balances from the mock (native 1 ETH, USDT 2.5).
      await expect(page.getByTestId('eth-address')).toHaveText(ETH_ADDRESS, { timeout: 15000 });
      await expect(page.getByTestId('eth-asset-ETH')).toContainText('1');
      await expect(page.getByTestId('eth-asset-USDT')).toContainText('2.5');

      // Deposit: address card + QR + network warning.
      await page.getByTestId('eth-deposit-ETH').click();
      await expect(page.getByTestId('eth-deposit-card')).toBeAttached();
      await expect(page.getByTestId('eth-deposit-address')).toHaveText(ETH_ADDRESS);
      await expect(page.getByTestId('eth-deposit-card')).toContainText('Send only ETH on Ethereum');
      expect(await page.locator('[data-testid="eth-deposit-card"] svg').count()).toBeGreaterThan(0);

      // Withdraw 1.5 USDT, then assert the broadcast payload is type-2 and
      // signed by this wallet (the mock only accepts a well-formed raw tx).
      await page.getByTestId('eth-withdraw-USDT').click();
      await page.getByTestId('eth-withdraw-to').fill(RECIPIENT);
      await page.getByTestId('eth-withdraw-amount').fill('1.5');
      await expect(page.getByTestId('eth-fee')).toContainText('Network fee up to', { timeout: 15000 });
      await page.getByTestId('eth-withdraw-submit').click();

      await expect(page.getByTestId('eth-screen')).toContainText('Transaction sent', { timeout: 20000 });
      await expect(page.getByTestId('eth-screen')).toContainText('Confirmed', { timeout: 20000 });

      const [tx] = mock.sent;
      expect(tx?.raw.startsWith('0x02')).toBe(true);
      expect(tx.raw.length).toBeGreaterThan(200);
      // ERC-20 transfer to the USDT contract: the 20-byte address and the
      // `transfer` selector appear verbatim in the RLP payload.
      expect(tx.raw.toLowerCase()).toContain('dac17f958d2ee523a2206206994597c13d831ec7');
      expect(tx.raw.toLowerCase()).toContain('a9059cbb');
    } finally {
      await mock.close();
    }
  });
});
