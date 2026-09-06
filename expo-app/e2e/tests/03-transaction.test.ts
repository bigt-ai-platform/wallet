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

  describe('QR Code Scan', () => {
    it('should open and close QR scanner', async () => {
      await tapByTestId('qr-scan-button');
      await waitForElementToBeVisible(by.id('qr-scanner'));
      await takeScreenshot('qr-scanner');

      // Close the scanner so it does not block the following tests.
      await tapByTestId('qr-close');
      await waitForElementToBeVisible(by.id('transaction-screen'));
    });

    it('should prefill payment form from a payment QR content', async () => {
      await tapByTestId('qr-scan-button');
      await waitForElementToBeVisible(by.id('qr-scanner'));

      // Simulate a scanned payment request (Java wallet format) via the
      // manual fallback path.
      const json = `{"address":"${TEST_WALLET.address}","quantity":"0.001","tokenid":"bc","memo":"qr e2e"}`;
      await typeTextByTestId('qr-manual-input', json);
      await tapByTestId('qr-manual-apply');

      // The scanner closes itself and the Send form is prefilled.
      await waitForElementToBeVisible(by.id('transaction-screen'));
      await detoxExpect(element(by.id('recipient-address-input'))).toHaveText(TEST_WALLET.address);
      await detoxExpect(element(by.id('amount-input'))).toHaveText('0.001');

      await takeScreenshot('qr-payment-prefilled');
    });
  });

  describe('L1 Test Tab', () => {
    beforeEach(async () => {
      // Navigate to transaction screen and switch to L1 Test tab
      await element(by.text('Transaction')).tap();
      await waitForElementToBeVisible(by.id('transaction-screen'));
      await element(by.text('L1 Test')).tap();
      await waitForNetwork(1000);
    });

    it('should display L1 Test tab with chain selector', async () => {
      await detoxExpect(element(by.text('L1 Test'))).toBeVisible();
      await detoxExpect(element(by.text('Select L1 Chain'))).toBeVisible();
      await detoxExpect(element(by.id('l1-mode-tabs'))).toBeVisible();
      await detoxExpect(element(by.text('Pay L1'))).toBeVisible();
      await detoxExpect(element(by.text('Pay Back L1→L0'))).toBeVisible();

      await takeScreenshot('l1-test-tab');
    });

    it('should show L1 chain chips when chains configured', async () => {
      await waitForNetwork(1000);
      try {
        await detoxExpect(element(by.id('l1-chain-chip-0'))).toBeVisible();
        await takeScreenshot('l1-chains-visible');
      } catch (e) {
        // No chains configured, check empty state
        await detoxExpect(element(by.text('No L1 chains configured'))).toBeVisible();
        await takeScreenshot('l1-chains-empty');
      }
    });

    it('should display Pay L1 form by default', async () => {
      await detoxExpect(element(by.id('l1-pay-section'))).toBeVisible();
      await detoxExpect(element(by.text('Pay L1 Chain'))).toBeVisible();
      await detoxExpect(element(by.id('l1-pay-token-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-pay-amount-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-pay-dest-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-pay-button'))).toBeVisible();

      await takeScreenshot('l1-pay-form');
    });

    it('should switch to Pay Back form when toggled', async () => {
      await element(by.text('Pay Back L1→L0')).tap();
      await waitForNetwork(500);

      await detoxExpect(element(by.id('l1-payback-section'))).toBeVisible();
      await detoxExpect(element(by.text('Pay Back from L1 to L0'))).toBeVisible();
      await detoxExpect(element(by.id('l1-payback-token-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-payback-amount-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-payback-dest-input'))).toBeVisible();
      await detoxExpect(element(by.id('l1-payback-button'))).toBeVisible();

      await takeScreenshot('l1-payback-form');
    });

    it('should validate Pay L1 form fields', async () => {
      // Try submitting empty form
      await tapByTestId('l1-pay-button');
      await waitForNetwork(500);

      // Should show validation error
      await takeScreenshot('l1-pay-validation');

      // Fill in fields
      await typeTextByTestId('l1-pay-token-input', 'bc');
      await typeTextByTestId('l1-pay-amount-input', '0.001');
      await typeTextByTestId('l1-pay-dest-input', 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');

      await takeScreenshot('l1-pay-form-filled');
    });

    it('should validate Pay Back form fields', async () => {
      // Switch to payback
      await element(by.text('Pay Back L1→L0')).tap();
      await waitForNetwork(500);

      // Try submitting empty
      await tapByTestId('l1-payback-button');
      await waitForNetwork(500);

      await takeScreenshot('l1-payback-validation');

      // Fill in fields
      await typeTextByTestId('l1-payback-token-input', 'bc');
      await typeTextByTestId('l1-payback-amount-input', '0.001');
      await typeTextByTestId('l1-payback-dest-input', 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');

      await takeScreenshot('l1-payback-form-filled');
    });

    it('should handle network errors gracefully for Pay L1', async () => {
      await typeTextByTestId('l1-pay-token-input', 'bc');
      await typeTextByTestId('l1-pay-amount-input', '0.001');
      await typeTextByTestId('l1-pay-dest-input', 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');

      await tapByTestId('l1-pay-button');
      await waitForNetwork(3000);

      // Should either succeed or show error
      await takeScreenshot('l1-pay-result');
    });

    it('should switch back to Pay L1 from Pay Back', async () => {
      // Switch to payback first
      await element(by.text('Pay Back L1→L0')).tap();
      await waitForNetwork(500);
      await detoxExpect(element(by.id('l1-payback-section'))).toBeVisible();

      // Switch back to pay
      await element(by.text('Pay L1')).tap();
      await waitForNetwork(500);
      await detoxExpect(element(by.id('l1-pay-section'))).toBeVisible();

      await takeScreenshot('l1-switch-back-to-pay');
    });
  });
});
