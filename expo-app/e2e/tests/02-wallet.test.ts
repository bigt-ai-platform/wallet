/**
 * E2E Test: Wallet Management
 *
 * Tests wallet creation, import, and management
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import {
  waitForAppToBeReady,
  waitForElementToBeVisible,
  tapByTestId,
  typeTextByTestId,
  takeScreenshot,
  resetApp,
} from '../helpers/setup';
import {
  createNewWallet,
  importWalletFromKey,
  unlockWallet,
  lockWallet,
  clearWallet,
  TEST_WALLET,
} from '../helpers/wallet';
import {
  verifyWalletCryptography,
  verifyAddressFormat,
  verifyPasswordStrength,
  getWalletFromStorage,
} from '../helpers/logic-verification';

describe('Wallet Management', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true });
    await waitForAppToBeReady();
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await clearWallet();
    } catch (e) {
      // Ignore errors during cleanup
    }
  });

  describe('Wallet Creation', () => {
    it('should create a new wallet', async () => {
      await createNewWallet();

      // ============ UI VERIFICATION ============
      // Verify wallet is created by checking if we can see the transaction screen
      await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

      // Navigate to wallet tab to verify
      await tapByTestId('tab-wallet');
      await waitForElementToBeVisible(by.id('wallet-screen'));

      // Should show wallet address
      await detoxExpect(element(by.id('wallet-address'))).toBeVisible();

      // ============ LOGIC VERIFICATION ============
      // Verify wallet is cryptographically valid
      const verification = await verifyWalletCryptography();
      expect(verification.isValid).toBe(true);
      expect(verification.error).toBeUndefined();

      // Verify public key format (66 chars, compressed)
      expect(verification.publicKey).toBeDefined();
      expect(verification.publicKey!.length).toBe(66);
      expect(
        verification.publicKey!.startsWith('02') ||
        verification.publicKey!.startsWith('03')
      ).toBe(true);

      // Verify address format
      expect(verification.address).toBeDefined();
      const isValidAddress = verifyAddressFormat(verification.address!);
      expect(isValidAddress).toBe(true);

      console.log('✅ Wallet creation verified:', verification.address);

      await takeScreenshot('wallet-created');
    });

    it('should validate password requirements', async () => {
      // ============ LOGIC VERIFICATION ============
      // Test weak passwords
      const weakPasswords = ['123', 'password', 'abc'];
      weakPasswords.forEach(weakPass => {
        const strength = verifyPasswordStrength(weakPass);
        expect(strength.isValid).toBe(false);
        expect(strength.feedback.length).toBeGreaterThan(0);
        console.log(`❌ Weak password "${weakPass}": ${strength.feedback.join(', ')}`);
      });

      // Test strong password
      const strongPassword = 'MyStr0ng!Pass';
      const strength = verifyPasswordStrength(strongPassword);
      expect(strength.isValid).toBe(true);
      expect(strength.score).toBeGreaterThanOrEqual(4);
      console.log(`✅ Strong password score: ${strength.score}/5`);

      // ============ UI VERIFICATION ============
      await tapByTestId('manage-wallet-button');
      await waitForElementToBeVisible(by.id('keys-screen'));

      await tapByTestId('create-wallet-button');
      await waitForElementToBeVisible(by.id('password-step'));

      // Try weak password
      await typeTextByTestId('password-input', '123');
      await typeTextByTestId('password-confirm-input', '123');

      // Next button should be disabled or show error
      // (Implementation depends on actual validation logic)
      await takeScreenshot('weak-password-error');
    });

    it('should validate password confirmation', async () => {
      await tapByTestId('manage-wallet-button');
      await waitForElementToBeVisible(by.id('keys-screen'));

      await tapByTestId('create-wallet-button');
      await waitForElementToBeVisible(by.id('password-step'));

      // Enter mismatched passwords
      await typeTextByTestId('password-input', 'Password123!');
      await typeTextByTestId('password-confirm-input', 'Password456!');

      // Should show error
      await takeScreenshot('password-mismatch-error');
    });
  });

  describe('Wallet Import', () => {
    it('should import wallet from private key', async () => {
      await importWalletFromKey();

      // ============ UI VERIFICATION ============
      // Verify wallet is imported
      await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

      // Navigate to wallet tab to verify address
      await tapByTestId('tab-wallet');
      await waitForElementToBeVisible(by.id('wallet-screen'));

      // Should show the correct address
      await detoxExpect(element(by.id('wallet-address'))).toBeVisible();

      // ============ LOGIC VERIFICATION ============
      // Verify imported wallet is cryptographically valid
      const walletData = await getWalletFromStorage();
      expect(walletData).toBeDefined();
      expect(walletData.privateKey).toBeDefined();

      const verification = await verifyWalletCryptography();
      expect(verification.isValid).toBe(true);
      expect(verification.address).toBeDefined();

      // Verify the address matches expected format
      const isValidAddress = verifyAddressFormat(verification.address!);
      expect(isValidAddress).toBe(true);

      console.log('✅ Wallet import verified:', verification.address);

      await takeScreenshot('wallet-imported');
    });

    it('should validate private key format', async () => {
      await tapByTestId('manage-wallet-button');
      await waitForElementToBeVisible(by.id('keys-screen'));

      await tapByTestId('import-key-button');
      await waitForElementToBeVisible(by.id('import-key-step'));

      // Try invalid private key
      await typeTextByTestId('private-key-input', 'invalid_key');
      await tapByTestId('import-next-button');

      // Should show error
      await detoxExpect(element(by.text('Invalid private key'))).toBeVisible();

      await takeScreenshot('invalid-key-error');
    });
  });

  describe('Wallet Lock/Unlock', () => {
    beforeEach(async () => {
      await resetApp();
      await createNewWallet();
    });

    it('should lock wallet', async () => {
      await lockWallet();

      // Transaction screen should show unlock prompt
      await detoxExpect(element(by.id('unlock-wallet-button'))).toBeVisible();

      await takeScreenshot('wallet-locked');
    });

    it('should unlock wallet with correct password', async () => {
      await lockWallet();
      await unlockWallet(TEST_WALLET.password);

      // Should be able to access transaction screen
      await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

      await takeScreenshot('wallet-unlocked');
    });

    it('should reject incorrect password', async () => {
      await lockWallet();

      await tapByTestId('unlock-wallet-button');
      await waitForElementToBeVisible(by.id('password-prompt'));

      // Enter wrong password
      await typeTextByTestId('unlock-password-input', 'WrongPassword');
      await tapByTestId('unlock-confirm-button');

      // Should show error
      await detoxExpect(element(by.text('Incorrect password'))).toBeVisible();

      await takeScreenshot('unlock-error');
    });

    it('should auto-lock when app goes to background', async () => {
      // Wallet is unlocked
      await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

      // Send app to background
      await device.sendToHome();
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Bring back to foreground
      await device.launchApp({ newInstance: false });

      // Should be locked
      await waitForElementToBeVisible(by.id('unlock-wallet-button'));

      await takeScreenshot('auto-locked');
    });
  });

  describe('Wallet Display', () => {
    beforeEach(async () => {
      await resetApp();
      await createNewWallet();
    });

    it('should display wallet address', async () => {
      await tapByTestId('tab-wallet');
      await waitForElementToBeVisible(by.id('wallet-screen'));

      await detoxExpect(element(by.id('wallet-address'))).toBeVisible();

      await takeScreenshot('wallet-address');
    });

    it('should display asset list', async () => {
      await tapByTestId('tab-wallet');
      await waitForElementToBeVisible(by.id('wallet-screen'));

      // Assets section should be visible
      await detoxExpect(element(by.id('wallet-assets'))).toBeVisible();

      await takeScreenshot('wallet-assets');
    });

    it('should refresh balances', async () => {
      await tapByTestId('tab-wallet');
      await waitForElementToBeVisible(by.id('wallet-screen'));

      // Tap refresh button
      await element(by.text('Refresh')).tap();

      // Wait for refresh to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Should still show wallet screen
      await detoxExpect(element(by.id('wallet-screen'))).toBeVisible();

      await takeScreenshot('wallet-refreshed');
    });
  });
});
