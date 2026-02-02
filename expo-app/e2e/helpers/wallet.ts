/**
 * Wallet E2E Test Helpers
 */

import { element, by, expect as detoxExpect } from 'detox';
import { tapByTestId, typeTextByTestId, waitForElementToBeVisible } from './setup';

/**
 * Test wallet data
 */
export const TEST_WALLET = {
  password: 'TestPassword123!',
  // Test private key (DO NOT USE IN PRODUCTION)
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
  // Corresponding address
  address: '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm',
};

/**
 * Create a new wallet
 */
export async function createNewWallet(password: string = TEST_WALLET.password) {
  // Navigate to wallet management
  await tapByTestId('manage-wallet-button');

  // Wait for keys screen
  await waitForElementToBeVisible(by.id('keys-screen'));

  // Tap create new wallet
  await tapByTestId('create-wallet-button');

  // Wait for password step
  await waitForElementToBeVisible(by.id('password-step'));

  // Enter password
  await typeTextByTestId('password-input', password);
  await typeTextByTestId('password-confirm-input', password);

  // Tap next
  await tapByTestId('password-next-button');

  // Wait for wallet to be created
  await waitForElementToBeVisible(by.id('wallet-created-step'), 10000);

  // Tap finish
  await tapByTestId('finish-button');

  // Should return to main screen with wallet loaded
  await waitForElementToBeVisible(by.id('transaction-screen'));
}

/**
 * Import wallet from private key
 */
export async function importWalletFromKey(
  privateKey: string = TEST_WALLET.privateKey,
  password: string = TEST_WALLET.password
) {
  // Navigate to wallet management
  await tapByTestId('manage-wallet-button');

  // Wait for keys screen
  await waitForElementToBeVisible(by.id('keys-screen'));

  // Tap import from key
  await tapByTestId('import-key-button');

  // Wait for import step
  await waitForElementToBeVisible(by.id('import-key-step'));

  // Enter private key
  await typeTextByTestId('private-key-input', privateKey);

  // Tap next
  await tapByTestId('import-next-button');

  // Wait for password step
  await waitForElementToBeVisible(by.id('password-step'));

  // Enter password
  await typeTextByTestId('password-input', password);
  await typeTextByTestId('password-confirm-input', password);

  // Tap finish
  await tapByTestId('finish-button');

  // Should return to main screen with wallet loaded
  await waitForElementToBeVisible(by.id('transaction-screen'));
}

/**
 * Unlock wallet
 */
export async function unlockWallet(password: string = TEST_WALLET.password) {
  // Check if unlock screen is visible
  const unlockVisible = await element(by.id('unlock-wallet-button')).exists();

  if (unlockVisible) {
    await tapByTestId('unlock-wallet-button');

    // Wait for password prompt
    await waitForElementToBeVisible(by.id('password-prompt'));

    // Enter password
    await typeTextByTestId('unlock-password-input', password);

    // Tap unlock
    await tapByTestId('unlock-confirm-button');

    // Wait for unlock to complete
    await waitForElementToBeVisible(by.id('transaction-screen'));
  }
}

/**
 * Lock wallet
 */
export async function lockWallet() {
  // Navigate to wallet tab
  await tapByTestId('tab-wallet');

  // Tap lock button
  await tapByTestId('lock-wallet-button');

  // Confirm lock if prompted
  const confirmVisible = await element(by.text('Lock Wallet')).exists();
  if (confirmVisible) {
    await element(by.text('Lock Wallet')).tap();
  }
}

/**
 * Check wallet balance for a token
 */
export async function checkWalletBalance(tokenName: string): Promise<void> {
  // Navigate to wallet tab
  await tapByTestId('tab-wallet');

  // Wait for assets to load
  await waitForElementToBeVisible(by.id('wallet-assets'));

  // Check if token exists in list
  await detoxExpect(element(by.text(tokenName))).toBeVisible();
}

/**
 * Get wallet address
 */
export async function getWalletAddress(): Promise<string> {
  // Navigate to wallet tab
  await tapByTestId('tab-wallet');

  // Wait for address to be visible
  await waitForElementToBeVisible(by.id('wallet-address'));

  // Get address text (this is a simplified version, actual implementation may vary)
  // In real tests, you might need to use a different method to extract text
  return TEST_WALLET.address; // Placeholder
}

/**
 * Clear wallet (for cleanup)
 */
export async function clearWallet() {
  try {
    // Navigate to wallet management
    await tapByTestId('manage-wallet-button');

    // Wait for keys screen
    await waitForElementToBeVisible(by.id('keys-screen'));

    // Tap clear wallet if button exists
    const clearVisible = await element(by.id('clear-wallet-button')).exists();
    if (clearVisible) {
      await tapByTestId('clear-wallet-button');

      // Confirm clear
      await element(by.text('Clear')).tap();
    }
  } catch (e) {
    // Wallet might not exist, ignore error
  }
}

/**
 * Export wallet file
 */
export async function exportWalletFile() {
  // Navigate to wallet management
  await tapByTestId('manage-wallet-button');

  // Wait for keys screen
  await waitForElementToBeVisible(by.id('keys-screen'));

  // Tap export button
  await tapByTestId('export-wallet-button');

  // Wait for export to complete
  await waitForElementToBeVisible(by.text('Wallet Exported'));

  // Dismiss success message
  await element(by.text('OK')).tap();
}
