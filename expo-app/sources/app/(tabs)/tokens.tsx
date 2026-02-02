/**
 * Tokens Screen
 *
 * Browse and search available tokens
 */

import * as React from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import type { TokenItem } from '@/types/api';

export default function TokensScreen() {
  

  const [tokens, setTokens] = React.useState<TokenItem[]>([]);
  const [filteredTokens, setFilteredTokens] = React.useState<TokenItem[]>([]);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    loadTokens();
  }, []);

  React.useEffect(() => {
    if (searchQuery.trim()) {
      const filtered = tokens.filter(
        (token) =>
          token.tokenname.toLowerCase().includes(searchQuery.toLowerCase()) ||
          token.tokenid.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredTokens(filtered);
    } else {
      setFilteredTokens(tokens);
    }
  }, [searchQuery, tokens]);

  const loadTokens = async () => {
    setLoading(true);
    try {
      const response = await httpService.getTokensItemList();
      if (response.success && response.data) {
        setTokens(response.data);
        setFilteredTokens(response.data);
      }
    } catch (error) {
      console.error('Error loading tokens:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={stylesheet.container}>
        <View style={stylesheet.centered}>
          <ActivityIndicator size="large" />
          <Text style={stylesheet.loadingText}>Loading tokens...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={stylesheet.container} testID="tokens-screen">
      <View style={stylesheet.searchContainer}>
        <TextInput
          testID="tokens-search-input"
          style={stylesheet.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search tokens..."
          placeholderTextColor={stylesheet.placeholder.color}
        />
      </View>

      <ScrollView contentContainerStyle={stylesheet.content} testID="tokens-scroll-view">
        {filteredTokens.length === 0 ? (
          <Text style={stylesheet.emptyText}>
            {searchQuery ? 'No tokens found matching your search' : 'No tokens available'}
          </Text>
        ) : (
          filteredTokens.map((token, index) => (
            <TouchableOpacity key={token.tokenid} style={stylesheet.tokenCard} testID={`token-card-${index}`}>
              <View style={stylesheet.tokenInfo}>
                <Text style={stylesheet.tokenName}>{token.tokenname}</Text>
                <Text style={stylesheet.tokenId}>{token.tokenid}</Text>
                {token.description && (
                  <Text style={stylesheet.tokenDescription} numberOfLines={2}>
                    {token.description}
                  </Text>
                )}
              </View>
              {token.decimals !== undefined && (
                <View style={stylesheet.tokenMeta}>
                  <Text style={stylesheet.tokenMetaText}>Decimals: {token.decimals}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  content: {
    padding: 16,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: theme.colors.text.secondary,
  },
  searchContainer: {
    padding: 16,
    paddingBottom: 8,
  },
  searchInput: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: theme.colors.text.primary,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  placeholder: {
    color: theme.colors.text.secondary,
  },
  emptyText: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    padding: 24,
  },
  tokenCard: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
  },
  tokenInfo: {
    marginBottom: 8,
  },
  tokenName: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  tokenId: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  tokenDescription: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    marginTop: 4,
  },
  tokenMeta: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  tokenMetaText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
}));
