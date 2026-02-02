/**
 * AI Chat Screen
 *
 * Conversational AI interface
 */

import * as React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import type { AiChatMessage } from '@/types/api';

export default function AiChatScreen() {
  

  const [messages, setMessages] = React.useState<AiChatMessage[]>([]);
  const [question, setQuestion] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const handleSend = async () => {
    if (!question.trim() || loading) return;

    const userQuestion = question.trim();
    setQuestion('');
    setLoading(true);

    // Add user message
    const newMessage: AiChatMessage = {
      id: Date.now().toString(),
      question: userQuestion,
      answer: '',
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, newMessage]);

    // Scroll to bottom
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await httpService.aiChatQuery(userQuestion);

      if (response.success && response.data) {
        // Update message with answer
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === newMessage.id ? { ...msg, answer: response.data! } : msg
          )
        );
      } else {
        // Update with error
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === newMessage.id
              ? { ...msg, answer: `Error: ${response.error || 'Failed to get response'}` }
              : msg
          )
        );
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === newMessage.id
            ? { ...msg, answer: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }
            : msg
        )
      );
    } finally {
      setLoading(false);
      // Scroll to bottom after answer
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  return (
    <KeyboardAvoidingView
      testID="aichat-screen"
      style={stylesheet.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      <ScrollView
        testID="aichat-messages-scroll"
        ref={scrollViewRef}
        style={stylesheet.messagesContainer}
        contentContainerStyle={stylesheet.messagesContent}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <View style={stylesheet.emptyContainer}>
            <Text style={stylesheet.emptyText}>Ask me anything about Bigtangle!</Text>
            <Text style={stylesheet.emptySubtext}>
              I can help with wallet questions, token information, and more.
            </Text>
          </View>
        ) : (
          messages.map((message, index) => (
            <View key={message.id} style={stylesheet.messageGroup} testID={`message-group-${index}`}>
              {/* User Question */}
              <View style={stylesheet.questionBubble} testID={`question-bubble-${index}`}>
                <Text style={stylesheet.questionText}>{message.question}</Text>
              </View>

              {/* AI Answer */}
              {message.answer ? (
                <View style={stylesheet.answerBubble} testID={`answer-bubble-${index}`}>
                  <Text style={stylesheet.answerText}>{message.answer}</Text>
                </View>
              ) : (
                <View style={stylesheet.answerBubble}>
                  <ActivityIndicator size="small" />
                </View>
              )}
            </View>
          ))
        )}

        {loading && messages.length > 0 && (
          <View style={stylesheet.loadingContainer}>
            <ActivityIndicator size="small" />
            <Text style={stylesheet.loadingText}>Thinking...</Text>
          </View>
        )}
      </ScrollView>

      <View style={stylesheet.inputContainer}>
        <TextInput
          testID="aichat-input"
          style={stylesheet.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="Ask a question..."
          placeholderTextColor={stylesheet.placeholder.color}
          multiline
          maxLength={500}
          editable={!loading}
          onSubmitEditing={handleSend}
        />
        <TouchableOpacity
          testID="aichat-send-button"
          style={[stylesheet.sendButton, (!question.trim() || loading) && stylesheet.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!question.trim() || loading}
        >
          <Text style={stylesheet.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
  messageGroup: {
    marginBottom: 16,
  },
  questionBubble: {
    backgroundColor: theme.colors.primary,
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
    alignSelf: 'flex-end',
    maxWidth: '80%',
  },
  questionText: {
    fontSize: 16,
    color: '#fff',
  },
  answerBubble: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 16,
    padding: 12,
    alignSelf: 'flex-start',
    maxWidth: '80%',
  },
  answerText: {
    fontSize: 16,
    color: theme.colors.text.primary,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 14,
    color: theme.colors.text.secondary,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.groupped.background,
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.colors.text.primary,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  placeholder: {
    color: theme.colors.text.secondary,
  },
  sendButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
}));
