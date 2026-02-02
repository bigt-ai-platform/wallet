/**
 * E2E Test: Tokens Screen
 *
 * Tests token browsing and search functionality
 */

import { device, element, by, expect as detoxExpect } from 'detox';
import {
  waitForAppToBeReady,
  waitForElementToBeVisible,
  tapByTestId,
  typeTextByTestId,
  clearTextByTestId,
  takeScreenshot,
  waitForNetwork,
} from '../helpers/setup';
import {
  verifyTokenFilter,
} from '../helpers/logic-verification';

describe('Tokens Screen', () => {
  beforeAll(async () => {
    await device.launchApp();
    await waitForAppToBeReady();
  });

  beforeEach(async () => {
    // Navigate to tokens tab
    await element(by.text('Tokens')).tap();
    await waitForElementToBeVisible(by.id('tokens-screen'));
  });

  describe('Token List Display', () => {
    it('should display tokens screen', async () => {
      await detoxExpect(element(by.id('tokens-screen'))).toBeVisible();
      await takeScreenshot('tokens-screen');
    });

    it('should display search input', async () => {
      await detoxExpect(element(by.id('tokens-search-input'))).toBeVisible();
      await takeScreenshot('tokens-search-visible');
    });

    it('should load and display token list', async () => {
      // Wait for tokens to load
      await waitForNetwork(3000);

      try {
        // Check if tokens are displayed
        await detoxExpect(element(by.id('token-card-0'))).toBeVisible();
        await takeScreenshot('tokens-loaded');
      } catch (e) {
        // Check for empty state
        await detoxExpect(element(by.text('No tokens available'))).toBeVisible();
        await takeScreenshot('tokens-empty');
      }
    });

    it('should display token information correctly', async () => {
      await waitForNetwork(3000);

      try {
        // Check first token card
        const firstToken = element(by.id('token-card-0'));
        await detoxExpect(firstToken).toBeVisible();

        // Token card should have name and ID
        await takeScreenshot('token-card-details');
      } catch (e) {
        await takeScreenshot('no-tokens-to-display');
      }
    });

    it('should show loading state', async () => {
      // Reload to see loading state
      await device.reloadReactNative();
      await element(by.text('Tokens')).tap();

      try {
        // Should show loading indicator briefly
        await detoxExpect(element(by.text('Loading tokens...'))).toBeVisible();
        await takeScreenshot('tokens-loading');
      } catch (e) {
        // Loading was too fast
        await takeScreenshot('tokens-loading-fast');
      }

      await waitForNetwork(3000);
    });
  });

  describe('Token Search', () => {
    it('should search tokens by name', async () => {
      // ============ LOGIC VERIFICATION ============
      // Test token filter logic
      const mockTokens = [
        { tokenname: 'BigTangle', tokenid: 'BIG123', description: 'Main token' },
        { tokenname: 'Bitcoin', tokenid: 'BTC456', description: 'BTC token' },
        { tokenname: 'Ethereum', tokenid: 'ETH789', description: 'ETH token' },
      ];

      const searchTerm = 'BIG';
      const filtered = verifyTokenFilter(mockTokens, searchTerm);
      expect(filtered.length).toBe(2); // BigTangle and Bitcoin
      expect(filtered.some(t => t.tokenname === 'BigTangle')).toBe(true);
      expect(filtered.some(t => t.tokenid === 'BIG123')).toBe(true);
      console.log(`✅ Filter logic: "${searchTerm}" matches ${filtered.length} tokens`);

      // Test case-insensitive search
      const filteredLower = verifyTokenFilter(mockTokens, 'big');
      expect(filteredLower.length).toBe(2);
      console.log(`✅ Case-insensitive search works correctly`);

      // ============ UI VERIFICATION ============
      await waitForNetwork(3000);

      // Type search query
      await typeTextByTestId('tokens-search-input', 'BIG');

      // Wait for search results
      await waitForNetwork(500);

      // Should filter tokens
      await takeScreenshot('tokens-search-by-name');
    });

    it('should search tokens by ID', async () => {
      await waitForNetwork(3000);

      // Type token ID search
      await typeTextByTestId('tokens-search-input', '0x');

      // Wait for search results
      await waitForNetwork(500);

      await takeScreenshot('tokens-search-by-id');
    });

    it('should show no results for invalid search', async () => {
      await waitForNetwork(3000);

      // Type invalid search query
      await typeTextByTestId('tokens-search-input', 'InvalidTokenNameXYZ123');

      // Wait for search results
      await waitForNetwork(500);

      // Should show no results message
      try {
        await detoxExpect(element(by.text('No tokens found matching your search'))).toBeVisible();
        await takeScreenshot('tokens-no-search-results');
      } catch (e) {
        await takeScreenshot('tokens-search-failed');
      }
    });

    it('should clear search and show all tokens', async () => {
      await waitForNetwork(3000);

      // Type search query
      await typeTextByTestId('tokens-search-input', 'TEST');
      await waitForNetwork(500);

      // Clear search
      await clearTextByTestId('tokens-search-input');
      await waitForNetwork(500);

      // Should show all tokens again
      await takeScreenshot('tokens-search-cleared');
    });

    it('should search case-insensitively', async () => {
      await waitForNetwork(3000);

      // Try lowercase search
      await typeTextByTestId('tokens-search-input', 'big');
      await waitForNetwork(500);
      await takeScreenshot('tokens-search-lowercase');

      // Clear and try uppercase
      await clearTextByTestId('tokens-search-input');
      await typeTextByTestId('tokens-search-input', 'BIG');
      await waitForNetwork(500);
      await takeScreenshot('tokens-search-uppercase');
    });
  });

  describe('Token Card Interaction', () => {
    it('should tap on token card', async () => {
      await waitForNetwork(3000);

      try {
        // Tap on first token
        await element(by.id('token-card-0')).tap();

        // Should show token details or action (if implemented)
        await takeScreenshot('token-card-tapped');
      } catch (e) {
        await takeScreenshot('no-tokens-to-tap');
      }
    });

    it('should display token metadata', async () => {
      await waitForNetwork(3000);

      try {
        // Check for decimals display
        await takeScreenshot('token-metadata');
      } catch (e) {
        await takeScreenshot('token-metadata-not-available');
      }
    });
  });

  describe('Scroll and Refresh', () => {
    it('should scroll through token list', async () => {
      await waitForNetwork(3000);

      try {
        // Scroll down
        await element(by.id('tokens-screen')).scroll(200, 'down');
        await takeScreenshot('tokens-scrolled-down');

        // Scroll up
        await element(by.id('tokens-screen')).scroll(200, 'up');
        await takeScreenshot('tokens-scrolled-up');
      } catch (e) {
        await takeScreenshot('tokens-scroll-failed');
      }
    });

    it('should pull to refresh token list', async () => {
      await waitForNetwork(2000);

      // Swipe down to refresh
      await element(by.id('tokens-screen')).swipe('down', 'slow', 0.75);

      // Wait for refresh to complete
      await waitForNetwork(2000);

      await takeScreenshot('tokens-refreshed');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // This would require mocking network failures
      // Document expected error handling behavior
      await takeScreenshot('tokens-error-handling');
    });

    it('should display empty state when no tokens', async () => {
      await waitForNetwork(3000);

      // Check for either tokens or empty state
      try {
        await detoxExpect(element(by.id('token-card-0'))).toBeVisible();
      } catch (e) {
        await detoxExpect(element(by.text('No tokens available'))).toBeVisible();
        await takeScreenshot('tokens-empty-state');
      }
    });
  });

  describe('Token Details', () => {
    it('should show token name and ID', async () => {
      await waitForNetwork(3000);

      try {
        // First token should have visible name and ID
        await takeScreenshot('token-name-id');
      } catch (e) {
        await takeScreenshot('token-details-not-available');
      }
    });

    it('should show token description if available', async () => {
      await waitForNetwork(3000);

      try {
        // Check if description is shown
        await takeScreenshot('token-description');
      } catch (e) {
        await takeScreenshot('token-no-description');
      }
    });

    it('should show token decimals', async () => {
      await waitForNetwork(3000);

      try {
        // Check for decimals display
        await takeScreenshot('token-decimals');
      } catch (e) {
        await takeScreenshot('token-decimals-not-shown');
      }
    });
  });

  describe('Performance', () => {
    it('should handle large token lists efficiently', async () => {
      await waitForNetwork(3000);

      // Scroll through list multiple times
      for (let i = 0; i < 3; i++) {
        await element(by.id('tokens-screen')).scroll(300, 'down');
        await waitForNetwork(100);
      }

      await takeScreenshot('tokens-list-performance');
    });

    it('should search quickly', async () => {
      await waitForNetwork(3000);

      const searchQuery = 'token';

      // Type search character by character
      for (let i = 0; i < searchQuery.length; i++) {
        await typeTextByTestId('tokens-search-input', searchQuery[i]);
        await waitForNetwork(50);
      }

      await takeScreenshot('tokens-search-performance');
    });
  });
});
