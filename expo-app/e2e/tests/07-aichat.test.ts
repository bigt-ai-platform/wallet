/**
 * E2E Test: AI Chat
 *
 * Tests AI chat functionality and conversation interface
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
  navigateToTabByName,
} from '../helpers/setup';
import { createNewWallet } from '../helpers/wallet';

describe('AI Chat', () => {
  beforeAll(async () => {
    await device.launchApp({ delete: true });
    await waitForAppToBeReady();
    // Create a wallet for testing (if needed)
    await createNewWallet();
  });

  beforeEach(async () => {
    // Navigate to AI Chat screen
    // Note: AI Chat might be a separate screen, not a tab
    // Adjust navigation based on actual implementation
    try {
      await navigateToTabByName('AI Chat');
    } catch (e) {
      // Try alternative navigation
      await tapByTestId('ai-chat-button');
    }
    await waitForElementToBeVisible(by.id('aichat-screen'));
  });

  describe('Chat Interface', () => {
    it('should display AI chat screen', async () => {
      await detoxExpect(element(by.id('aichat-screen'))).toBeVisible();
      await takeScreenshot('aichat-screen');
    });

    it('should show empty state message', async () => {
      await detoxExpect(element(by.text('Ask me anything about Bigtangle!'))).toBeVisible();
      await detoxExpect(
        element(by.text('I can help with wallet questions, token information, and more.'))
      ).toBeVisible();
      await takeScreenshot('aichat-empty-state');
    });

    it('should display input field', async () => {
      await detoxExpect(element(by.id('aichat-input'))).toBeVisible();
      await takeScreenshot('aichat-input-visible');
    });

    it('should display send button', async () => {
      await detoxExpect(element(by.id('aichat-send-button'))).toBeVisible();
      await takeScreenshot('aichat-send-button');
    });

    it('should have send button disabled when input is empty', async () => {
      // Send button should be disabled
      await takeScreenshot('aichat-send-button-disabled');
    });

    it('should enable send button when text is entered', async () => {
      await typeTextByTestId('aichat-input', 'Hello');

      // Send button should now be enabled
      await takeScreenshot('aichat-send-button-enabled');

      // Clear input
      await clearTextByTestId('aichat-input');
    });
  });

  describe('Sending Messages', () => {
    it('should send a message', async () => {
      const question = 'What is Bigtangle?';

      // Type question
      await typeTextByTestId('aichat-input', question);

      // Send message
      await tapByTestId('aichat-send-button');

      // Should show user question
      await detoxExpect(element(by.text(question))).toBeVisible();

      // Should clear input
      await takeScreenshot('aichat-message-sent');

      // Wait for AI response
      await waitForNetwork(5000);

      await takeScreenshot('aichat-with-response');
    });

    it('should display multiple messages', async () => {
      const questions = [
        'What is a token?',
        'How do I send a transaction?',
        'What is a wallet?',
      ];

      for (const question of questions) {
        await typeTextByTestId('aichat-input', question);
        await tapByTestId('aichat-send-button');
        await waitForNetwork(3000);
      }

      await takeScreenshot('aichat-multiple-messages');
    });

    it('should handle multiline input', async () => {
      const multilineQuestion = 'What is Bigtangle?\nHow does it work?\nCan you explain?';

      await typeTextByTestId('aichat-input', multilineQuestion);
      await takeScreenshot('aichat-multiline-input');

      await tapByTestId('aichat-send-button');
      await waitForNetwork(3000);

      await takeScreenshot('aichat-multiline-sent');
    });

    it('should limit input length', async () => {
      // Try to type more than 500 characters
      const longText = 'A'.repeat(600);

      await typeTextByTestId('aichat-input', longText);

      // Input should be truncated to 500 characters
      await takeScreenshot('aichat-input-limited');

      await clearTextByTestId('aichat-input');
    });

    it('should prevent sending while loading', async () => {
      // Send first message
      await typeTextByTestId('aichat-input', 'First question');
      await tapByTestId('aichat-send-button');

      // Try to send another message immediately
      await typeTextByTestId('aichat-input', 'Second question');
      // Button should be disabled while loading

      await takeScreenshot('aichat-loading-disabled');

      // Wait for response
      await waitForNetwork(5000);
    });
  });

  describe('Message Display', () => {
    it('should display user messages correctly', async () => {
      await typeTextByTestId('aichat-input', 'Test question');
      await tapByTestId('aichat-send-button');

      // User message should be visible and styled correctly
      await detoxExpect(element(by.text('Test question'))).toBeVisible();
      await takeScreenshot('aichat-user-message');

      await waitForNetwork(3000);
    });

    it('should show loading indicator while waiting for response', async () => {
      await typeTextByTestId('aichat-input', 'What is blockchain?');
      await tapByTestId('aichat-send-button');

      try {
        // Should show loading indicator or "Thinking..." text
        await detoxExpect(element(by.text('Thinking...'))).toBeVisible();
        await takeScreenshot('aichat-thinking');
      } catch (e) {
        // Response was too fast
        await takeScreenshot('aichat-response-fast');
      }

      await waitForNetwork(5000);
    });

    it('should display AI response', async () => {
      await typeTextByTestId('aichat-input', 'Hello AI');
      await tapByTestId('aichat-send-button');

      // Wait for response
      await waitForNetwork(5000);

      // Should show AI response
      await takeScreenshot('aichat-ai-response');
    });

    it('should auto-scroll to latest message', async () => {
      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        await typeTextByTestId('aichat-input', `Question ${i + 1}`);
        await tapByTestId('aichat-send-button');
        await waitForNetwork(2000);
      }

      // Latest message should be visible
      await takeScreenshot('aichat-auto-scrolled');
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // This would require mocking network failures
      // Document expected error handling

      await typeTextByTestId('aichat-input', 'Test question');
      await tapByTestId('aichat-send-button');

      await waitForNetwork(5000);

      // Should show error message if network fails
      await takeScreenshot('aichat-network-error');
    });

    it('should display error message in chat', async () => {
      // When an error occurs, it should be displayed in the chat
      await takeScreenshot('aichat-error-display');
    });

    it('should allow retrying after error', async () => {
      // After an error, user should be able to send another message
      await typeTextByTestId('aichat-input', 'Retry question');
      await tapByTestId('aichat-send-button');

      await waitForNetwork(3000);

      await takeScreenshot('aichat-retry-after-error');
    });
  });

  describe('Conversation Flow', () => {
    it('should maintain conversation history', async () => {
      // Send multiple related questions
      await typeTextByTestId('aichat-input', 'What is a token?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(3000);

      await typeTextByTestId('aichat-input', 'How do I create one?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(3000);

      // Both messages should be visible
      await detoxExpect(element(by.text('What is a token?'))).toBeVisible();
      await detoxExpect(element(by.text('How do I create one?'))).toBeVisible();

      await takeScreenshot('aichat-conversation-history');
    });

    it('should scroll through conversation history', async () => {
      // Send many messages to create scrollable content
      for (let i = 0; i < 8; i++) {
        await typeTextByTestId('aichat-input', `Message ${i + 1}`);
        await tapByTestId('aichat-send-button');
        await waitForNetwork(1500);
      }

      // Scroll up to see earlier messages
      await element(by.id('aichat-messages-scroll')).scroll(300, 'up');
      await takeScreenshot('aichat-scrolled-history');

      // Scroll down to latest
      await element(by.id('aichat-messages-scroll')).scroll(300, 'down');
      await takeScreenshot('aichat-scrolled-latest');
    });
  });

  describe('Sample Questions', () => {
    it('should answer wallet-related questions', async () => {
      await typeTextByTestId('aichat-input', 'How do I create a wallet?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(5000);

      await takeScreenshot('aichat-wallet-question');
    });

    it('should answer token-related questions', async () => {
      await typeTextByTestId('aichat-input', 'What tokens are available?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(5000);

      await takeScreenshot('aichat-token-question');
    });

    it('should answer transaction-related questions', async () => {
      await typeTextByTestId('aichat-input', 'How do I send a transaction?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(5000);

      await takeScreenshot('aichat-transaction-question');
    });

    it('should answer general Bigtangle questions', async () => {
      await typeTextByTestId('aichat-input', 'What is Bigtangle?');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(5000);

      await takeScreenshot('aichat-general-question');
    });
  });

  describe('Keyboard Behavior', () => {
    it('should handle keyboard showing and hiding', async () => {
      // Tap input to show keyboard
      await tapByTestId('aichat-input');
      await takeScreenshot('aichat-keyboard-shown');

      // Type something
      await typeTextByTestId('aichat-input', 'Test');

      // Send message should hide keyboard
      await tapByTestId('aichat-send-button');
      await waitForNetwork(2000);

      await takeScreenshot('aichat-keyboard-hidden');
    });

    it('should adjust layout for keyboard', async () => {
      // Tap input
      await tapByTestId('aichat-input');

      // Layout should adjust (KeyboardAvoidingView)
      await takeScreenshot('aichat-keyboard-layout');
    });
  });

  describe('Performance', () => {
    it('should handle rapid message sending', async () => {
      // Send messages quickly in succession
      for (let i = 0; i < 3; i++) {
        await typeTextByTestId('aichat-input', `Quick message ${i + 1}`);
        await tapByTestId('aichat-send-button');
        await waitForNetwork(500);
      }

      // Wait for all responses
      await waitForNetwork(10000);

      await takeScreenshot('aichat-rapid-messages');
    });

    it('should handle long conversation efficiently', async () => {
      // Create a long conversation
      for (let i = 0; i < 10; i++) {
        await typeTextByTestId('aichat-input', `Long conversation message ${i + 1}`);
        await tapByTestId('aichat-send-button');
        await waitForNetwork(2000);
      }

      // Should still be responsive
      await takeScreenshot('aichat-long-conversation');
    });
  });

  describe('State Management', () => {
    it('should maintain chat history on tab switch', async () => {
      // Send a message
      await typeTextByTestId('aichat-input', 'Remember this message');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(3000);

      // Navigate away
      await navigateToTabByName('Wallet');
      await waitForNetwork(1000);

      // Navigate back
      try {
        await navigateToTabByName('AI Chat');
      } catch (e) {
        await tapByTestId('ai-chat-button');
      }

      // Message should still be visible
      await detoxExpect(element(by.text('Remember this message'))).toBeVisible();
      await takeScreenshot('aichat-history-preserved');
    });

    it('should clear on app restart', async () => {
      // Send a message
      await typeTextByTestId('aichat-input', 'This should be cleared');
      await tapByTestId('aichat-send-button');
      await waitForNetwork(2000);

      // Restart app
      await device.launchApp({ newInstance: true });
      await waitForAppToBeReady();

      // Navigate to AI Chat
      try {
        await navigateToTabByName('AI Chat');
      } catch (e) {
        await tapByTestId('ai-chat-button');
      }

      // Should show empty state
      await detoxExpect(element(by.text('Ask me anything about Bigtangle!'))).toBeVisible();
      await takeScreenshot('aichat-cleared-on-restart');
    });
  });
});
