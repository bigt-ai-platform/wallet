/**
 * E2E Test: Wallet Logic Verification
 *
 * Combines UI testing with business logic verification.
 * Tests that wallet operations not only work in the UI,
 * but also produce cryptographically valid and correct results.
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
  verifyWalletCryptography,
  verifyAddressFormat,
  verifyKeyPair,
  verifyPasswordStrength,
  getWalletFromStorage,
} from '../helpers/logic-verification';

describe('Wallet Logic Verification', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true });
    await waitForAppToBeReady();
  });

  beforeEach(async () => {
    await resetApp();
  });

  describe('Wallet Creation - UI + Logic', () => {
    it('should create cryptographically valid wallet', async () => {
      const password = 'TestPassword123!';

      // ============ UI AUTOMATION ============
      // Create wallet through UI
      await tapByTestId('create-wallet-button');
      await waitForElementToBeVisible(by.id('password-input'));

      await typeTextByTestId('password-input', password);
      await typeTextByTestId('password-confirm-input', password);
      await tapByTestId('create-button');

      // Wait for wallet creation
      await waitForElementToBeVisible(by.id('wallet-address'));

      await takeScreenshot('wallet-created');

      // ============ LOGIC VERIFICATION ============
      // Verify wallet was actually created with valid cryptography
      const verification = await verifyWalletCryptography();

      // Should have valid wallet
      expect(verification.isValid).toBe(true);
      expect(verification.error).toBeUndefined();

      // Should have valid public key (66 chars, compressed format)
      expect(verification.publicKey).toBeDefined();
      expect(verification.publicKey!.length).toBe(66);
      expect(
        verification.publicKey!.startsWith('02') ||
        verification.publicKey!.startsWith('03')
      ).toBe(true);

      // Should have valid Bitcoin address format
      expect(verification.address).toBeDefined();
      const isValidAddress = verifyAddressFormat(verification.address!);
      expect(isValidAddress).toBe(true);

      // ============ UI + LOGIC CONSISTENCY ============
      // Verify displayed address matches computed address
      const addrAttrs: any = await element(by.id('wallet-address')).getAttributes();
      const displayedAddress = addrAttrs.text || addrAttrs.label || '';
      expect(displayedAddress).toBe(verification.address);

      console.log('✅ Wallet creation verified:');
      console.log(`   Address: ${verification.address}`);
      console.log(`   Public Key: ${verification.publicKey}`);
    });

    it('should validate password strength correctly', async () => {
      // Test weak passwords
      const weakPasswords = ['123', 'password', 'abc123'];

      for (const weakPass of weakPasswords) {
        // ============ LOGIC VERIFICATION ============
        const strength = verifyPasswordStrength(weakPass);
        expect(strength.isValid).toBe(false);
        expect(strength.feedback.length).toBeGreaterThan(0);

        console.log(`❌ Weak password "${weakPass}": ${strength.feedback.join(', ')}`);
      }

      // Test strong password
      const strongPassword = 'MyStr0ng!Pass';

      // ============ LOGIC VERIFICATION ============
      const strength = verifyPasswordStrength(strongPassword);
      expect(strength.isValid).toBe(true);
      expect(strength.score).toBeGreaterThanOrEqual(4);

      console.log(`✅ Strong password score: ${strength.score}/5`);

      // ============ UI AUTOMATION ============
      // UI should accept strong password
      await tapByTestId('create-wallet-button');
      await waitForElementToBeVisible(by.id('password-input'));

      await typeTextByTestId('password-input', strongPassword);
      await typeTextByTestId('password-confirm-input', strongPassword);

      // Next button should be enabled or no error shown
      await tapByTestId('create-button');

      await waitForElementToBeVisible(by.id('wallet-address'), 10000);
      await takeScreenshot('strong-password-accepted');
    });

    it('should reject mismatched passwords', async () => {
      // ============ UI AUTOMATION ============
      await tapByTestId('create-wallet-button');
      await waitForElementToBeVisible(by.id('password-input'));

      await typeTextByTestId('password-input', 'Password123!');
      await typeTextByTestId('password-confirm-input', 'Password456!');

      await tapByTestId('create-button');

      // ============ UI VERIFICATION ============
      // Should show error message
      await waitForElementToBeVisible(by.text('Passwords do not match'));

      await takeScreenshot('password-mismatch-error');
    });
  });

  describe('Wallet Import - UI + Logic', () => {
    it('should import wallet with valid key', async () => {
      // Known valid test key
      const testPrivateKey = 'ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f';

      // ============ LOGIC VERIFICATION (Pre-import) ============
      // Verify the key is valid before importing
      const keyVerification = await verifyKeyPair(testPrivateKey);
      expect(keyVerification.isValid).toBe(true);
      expect(keyVerification.address).toBeDefined();

      const expectedAddress = keyVerification.address!;

      console.log(`Importing key for address: ${expectedAddress}`);

      // ============ UI AUTOMATION ============
      await tapByTestId('import-wallet-button');
      await waitForElementToBeVisible(by.id('private-key-input'));

      await typeTextByTestId('private-key-input', testPrivateKey);
      await typeTextByTestId('password-input', 'TestPassword123!');

      await tapByTestId('import-button');

      // Wait for import to complete
      await waitForElementToBeVisible(by.id('wallet-address'), 10000);

      await takeScreenshot('wallet-imported');

      // ============ LOGIC VERIFICATION (Post-import) ============
      // Verify wallet was imported correctly
      const walletData = await getWalletFromStorage();
      expect(walletData).toBeDefined();
      expect(walletData.privateKey).toBe(testPrivateKey);

      // Verify cryptography
      const verification = await verifyWalletCryptography();
      expect(verification.isValid).toBe(true);
      expect(verification.address).toBe(expectedAddress);

      // ============ UI + LOGIC CONSISTENCY ============
      // Verify displayed address matches expected address
      const addrAttrs2: any = await element(by.id('wallet-address')).getAttributes();
      const displayedAddress = addrAttrs2.text || addrAttrs2.label || '';
      expect(displayedAddress).toBe(expectedAddress);

      console.log('✅ Import verified:');
      console.log(`   Expected address: ${expectedAddress}`);
      console.log(`   Displayed address: ${displayedAddress}`);
      console.log(`   Match: ${displayedAddress === expectedAddress}`);
    });

    it('should reject invalid private key format', async () => {
      const invalidKeys = [
        'invalid_key',
        '123',
        'not_a_hex_string',
        'gg' + 'a'.repeat(62), // Invalid hex characters
      ];

      for (const invalidKey of invalidKeys) {
        // ============ LOGIC VERIFICATION ============
        const keyVerification = await verifyKeyPair(invalidKey);
        expect(keyVerification.isValid).toBe(false);
        expect(keyVerification.error).toBeDefined();

        console.log(`❌ Invalid key "${invalidKey.substring(0, 10)}...": ${keyVerification.error}`);

        // ============ UI AUTOMATION ============
        await tapByTestId('import-wallet-button');
        await waitForElementToBeVisible(by.id('private-key-input'));

        await typeTextByTestId('private-key-input', invalidKey);
        await tapByTestId('import-button');

        // ============ UI VERIFICATION ============
        // Should show error
        await waitForElementToBeVisible(by.text('Invalid private key'));

        await takeScreenshot(`invalid-key-${invalidKey.substring(0, 5)}`);

        // Close error and try next
        await tapByTestId('close-button');
      }
    });

    it('should derive same address from same key', async () => {
      const testKey = 'ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f';

      // ============ LOGIC VERIFICATION ============
      // Derive address multiple times - should always be the same
      const verification1 = await verifyKeyPair(testKey);
      const verification2 = await verifyKeyPair(testKey);
      const verification3 = await verifyKeyPair(testKey);

      expect(verification1.address).toBe(verification2.address);
      expect(verification2.address).toBe(verification3.address);

      console.log('✅ Deterministic address derivation verified');
      console.log(`   All derivations produced: ${verification1.address}`);

      // ============ UI AUTOMATION ============
      // Import twice and verify both show same address
      await tapByTestId('import-wallet-button');
      await typeTextByTestId('private-key-input', testKey);
      await typeTextByTestId('password-input', 'Pass123!');
      await tapByTestId('import-button');

      await waitForElementToBeVisible(by.id('wallet-address'));
      const firstAttrs: any = await element(by.id('wallet-address')).getAttributes();
      const firstImportAddress = firstAttrs.text || firstAttrs.label || '';

      // Clear and import again
      await tapByTestId('clear-wallet-button');
      await tapByTestId('confirm-clear-button');

      await tapByTestId('import-wallet-button');
      await typeTextByTestId('private-key-input', testKey);
      await typeTextByTestId('password-input', 'Pass123!');
      await tapByTestId('import-button');

      await waitForElementToBeVisible(by.id('wallet-address'));
      const secondAttrs: any = await element(by.id('wallet-address')).getAttributes();
      const secondImportAddress = secondAttrs.text || secondAttrs.label || '';

      // ============ UI + LOGIC CONSISTENCY ============
      expect(firstImportAddress).toBe(secondImportAddress);
      expect(firstImportAddress).toBe(verification1.address);

      await takeScreenshot('deterministic-import-verified');
    });
  });

  describe('Address Validation', () => {
    it('should validate Bitcoin address format', async () => {
      const validAddresses = [
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Genesis block
        '3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy',
      ];

      const invalidAddresses = [
        'invalid',
        '0x1234567890abcdef',
        '',
        '1234',
      ];

      // ============ LOGIC VERIFICATION ============
      validAddresses.forEach((addr) => {
        const isValid = verifyAddressFormat(addr);
        expect(isValid).toBe(true);
        console.log(`✅ Valid address: ${addr}`);
      });

      invalidAddresses.forEach((addr) => {
        const isValid = verifyAddressFormat(addr);
        expect(isValid).toBe(false);
        console.log(`❌ Invalid address: ${addr || '(empty)'}`);
      });
    });
  });
});
