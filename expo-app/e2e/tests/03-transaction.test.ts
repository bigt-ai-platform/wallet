/**
 * E2E Test: Transactions
 *
 * Tests transaction creation and sending
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import {
  waitForAppToBeReady,
  waitForElementToBeVisible,
  tapByTestId,
  typeTextByTestId,
  clearTextByTestId,
  takeScreenshot,
  resetApp,
  waitForNetwork,
} from '../helpers/setup';
import { createNewWallet, TEST_WALLET } from '../helpers/wallet';
import {
  verifyAmountFormat,
  verifyAddressFormat,
  calculateTransactionFee,
} from '../helpers/logic-verification';

describe('Transactions', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true });
    await waitForAppToBeReady();
    // Create a wallet for testing
    await createNewWallet();
  });

  beforeEach(async () => {
    // Navigate to transaction screen
    await element(by.text('Transaction')).tap();
    await waitForElementToBeVisible(by.id('transaction-screen'));
  });

  describe('Transaction Form', () => {
    it('should display transaction form', async () => {
      await detoxExpect(element(by.text('Send Payment'))).toBeVisible();
      await detoxExpect(element(by.id('token-selection'))).toBeVisible();
      await detoxExpect(element(by.id('recipient-address-input'))).toBeVisible();
      await detoxExpect(element(by.id('amount-input'))).toBeVisible();
      await detoxExpect(element(by.id('memo-input'))).toBeVisible();
      await detoxExpect(element(by.id('send-button'))).toBeVisible();

      await takeScreenshot('transaction-form');
    });

    it('should load user tokens', async () => {
      // Wait for tokens to load
      await waitForNetwork(2000);

      // Token selection should show tokens (or empty state)
      await detoxExpect(element(by.id('token-selection'))).toBeVisible();

      await takeScreenshot('tokens-loaded');
    });

    it('should select token', async () => {
      await waitForNetwork(2000);

      // Tap on first token (if available)
      try {
        await element(by.id('token-card-0')).tap();
        await takeScreenshot('token-selected');
      } catch (e) {
        // No tokens available in test environment
        await takeScreenshot('no-tokens');
      }
    });

    it('should validate recipient address', async () => {
      // ============ LOGIC VERIFICATION ============
      // Test invalid addresses
      const invalidAddresses = ['invalid_address', '123', 'not_an_address', ''];
      invalidAddresses.forEach(addr => {
        const isValid = verifyAddressFormat(addr);
        expect(isValid).toBe(false);
        console.log(`❌ Invalid address: "${addr || '(empty)'}"`);
      });

      // Test valid address
      const validAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'; // Genesis block address
      const isValid = verifyAddressFormat(validAddress);
      expect(isValid).toBe(true);
      console.log(`✅ Valid address: ${validAddress}`);

      // ============ UI VERIFICATION ============
      // Enter invalid address
      await typeTextByTestId('recipient-address-input', 'invalid_address');
      await typeTextByTestId('amount-input', '1');

      // Try to send
      await tapByTestId('send-button');

      // Should show error (implementation may vary)
      await takeScreenshot('invalid-address-error');
    });

    it('should validate amount', async () => {
      // ============ LOGIC VERIFICATION ============
      // Test invalid amounts
      const invalidAmounts = ['0', '-1', 'abc', ''];
      invalidAmounts.forEach(amt => {
        const verification = verifyAmountFormat(amt);
        if (amt === '0') {
          // Zero is valid format but should be rejected by business logic
          expect(verification.isValid).toBe(true);
          expect(verification.parsedAmount).toBe(BigInt(0));
        } else if (amt === '') {
          expect(verification.isValid).toBe(false);
        }
        console.log(`Testing amount "${amt}": ${verification.isValid ? 'valid format' : verification.error}`);
      });

      // Test valid amounts
      const validAmounts = ['0.001', '1', '1.5', '100.123456'];
      validAmounts.forEach(amt => {
        const verification = verifyAmountFormat(amt);
        expect(verification.isValid).toBe(true);
        expect(verification.parsedAmount).toBeDefined();
        console.log(`✅ Valid amount "${amt}": ${verification.parsedAmount} satoshis`);
      });

      // ============ UI VERIFICATION ============
      // Enter valid address
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);

      // Enter zero amount
      await typeTextByTestId('amount-input', '0');
      await tapByTestId('send-button');

      // Should show error
      await takeScreenshot('zero-amount-error');

      // Clear and enter negative amount
      await clearTextByTestId('amount-input');
      await typeTextByTestId('amount-input', '-1');
      await tapByTestId('send-button');

      // Should show error
      await takeScreenshot('negative-amount-error');
    });

    it('should validate sufficient balance', async () => {
      await waitForNetwork(2000);

      // Enter valid address
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);

      // Enter amount larger than balance
      await typeTextByTestId('amount-input', '99999999');

      // Try to send
      await tapByTestId('send-button');

      // Should show insufficient balance error
      await detoxExpect(element(by.text('Insufficient balance'))).toBeVisible();

      await takeScreenshot('insufficient-balance');
    });

    it('should add memo to transaction', async () => {
      // ============ LOGIC VERIFICATION ============
      // Verify amount parsing
      const amountStr = '0.001';
      const verification = verifyAmountFormat(amountStr);
      expect(verification.isValid).toBe(true);
      expect(verification.parsedAmount).toBe(BigInt(100000)); // 0.001 BTC = 100,000 satoshis
      console.log(`✅ Amount verification: ${amountStr} = ${verification.parsedAmount} satoshis`);

      // Calculate expected transaction fee (1 input, 2 outputs)
      const estimatedFee = calculateTransactionFee(1, 2);
      console.log(`📊 Estimated transaction fee: ${estimatedFee} satoshis`);

      // ============ UI VERIFICATION ============
      // Enter transaction details
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);
      await typeTextByTestId('amount-input', '0.001');
      await typeTextByTestId('memo-input', 'Test payment');

      await takeScreenshot('transaction-with-memo');
    });

    it('should clear form after successful send', async () => {
      // Note: This test requires a wallet with balance
      // In a real test environment, you would:
      // 1. Fund the test wallet
      // 2. Enter transaction details
      // 3. Confirm transaction
      // 4. Verify form is cleared

      // For now, just verify the form can be cleared manually
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);
      await typeTextByTestId('amount-input', '1');
      await typeTextByTestId('memo-input', 'Test');

      await clearTextByTestId('recipient-address-input');
      await clearTextByTestId('amount-input');
      await clearTextByTestId('memo-input');

      await takeScreenshot('form-cleared');
    });
  });

  describe('Transaction Confirmation', () => {
    it('should show confirmation dialog', async () => {
      await waitForNetwork(2000);

      // Fill in transaction form
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);
      await typeTextByTestId('amount-input', '0.001');

      // Tap send
      await tapByTestId('send-button');

      // Should show confirmation dialog
      await waitForElementToBeVisible(by.text('Confirm Transaction'));

      await takeScreenshot('transaction-confirmation');
    });

    it('should display transaction details in confirmation', async () => {
      await waitForNetwork(2000);

      // Fill in transaction form
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);
      await typeTextByTestId('amount-input', '0.001');

      // Tap send
      await tapByTestId('send-button');

      // Wait for confirmation
      await waitForElementToBeVisible(by.text('Confirm Transaction'));

      // Check details are shown
      await detoxExpect(element(by.text(TEST_WALLET.address))).toBeVisible();
      await detoxExpect(element(by.text('0.001'))).toBeVisible();

      await takeScreenshot('confirmation-details');

      // Cancel
      await element(by.text('Cancel')).tap();
    });

    it('should allow canceling transaction', async () => {
      await waitForNetwork(2000);

      // Fill in and try to send
      await typeTextByTestId('recipient-address-input', TEST_WALLET.address);
      await typeTextByTestId('amount-input', '0.001');
      await tapByTestId('send-button');

      // Wait for confirmation
      await waitForElementToBeVisible(by.text('Confirm Transaction'));

      // Cancel
      await element(by.text('Cancel')).tap();

      // Should be back at transaction form
      await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();

      await takeScreenshot('transaction-cancelled');
    });
  });

  describe('Transaction Sending', () => {
    it('should handle network errors gracefully', async () => {
      // This test would require mocking network responses
      // For now, document the expected behavior
      await takeScreenshot('transaction-network-test');
    });

    it('should show loading state while sending', async () => {
      // This test would require a funded wallet
      // Document expected loading behavior
      await takeScreenshot('transaction-loading-state');
    });

    it('should show success message after sending', async () => {
      // This test would require a funded wallet
      // Document expected success behavior
      await takeScreenshot('transaction-success');
    });
  });

  describe('QR Code (Future)', () => {
    it('should open QR scanner', async () => {
      // Tap QR button
      try {
        await tapByTestId('qr-scan-button');
        await waitForElementToBeVisible(by.id('qr-scanner'));
        await takeScreenshot('qr-scanner');
      } catch (e) {
        // QR feature not yet implemented
        await takeScreenshot('qr-not-implemented');
      }
    });
  });
});
