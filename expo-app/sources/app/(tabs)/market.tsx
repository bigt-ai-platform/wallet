/**
 * Market Screen
 *
 * Shows market prices and trading information
 */

import * as React from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import type { MarketPrice } from '@/types/api';

export default function MarketScreen() {
  

  const [prices, setPrices] = React.useState<MarketPrice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    loadPrices();
  }, []);

  const loadPrices = async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await httpService.getMarketPrices();
      if (response.success && response.data) {
        setPrices(response.data);
      }
    } catch (error) {
      console.error('Error loading market prices:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    loadPrices(true);
  };

  const formatChange = (change: string) => {
    const num = parseFloat(change);
    if (isNaN(num)) return '0%';
    const sign = num >= 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  };

  const getChangeColor = (change: string) => {
    const num = parseFloat(change);
    if (isNaN(num) || num === 0) return stylesheet.changeNeutral.color;
    return num > 0 ? stylesheet.changePositive.color : stylesheet.changeNegative.color;
  };

  if (loading) {
    return (
      <View style={stylesheet.container} testID="market-screen">
        <View style={stylesheet.centered}>
          <ActivityIndicator size="large" />
          <Text style={stylesheet.loadingText}>Loading market prices...</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={stylesheet.container}
      contentContainerStyle={stylesheet.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      testID="market-screen"
    >
      <Text style={stylesheet.title}>Market Prices</Text>

      {prices.length === 0 ? (
        <Text style={stylesheet.emptyText}>No market data available</Text>
      ) : (
        prices.map((item, index) => (
          <View key={index} style={stylesheet.priceCard} testID={`price-card-${index}`}>
            <View style={stylesheet.priceLeft}>
              <Text style={stylesheet.tokenName}>{item.tokenname}</Text>
              <Text style={stylesheet.tokenId}>{item.tokenid.substring(0, 16)}...</Text>
            </View>
            <View style={stylesheet.priceRight}>
              <Text style={stylesheet.price}>{item.price}</Text>
              <Text style={[stylesheet.change, { color: getChangeColor(item.change) }]}>
                {formatChange(item.change)}
              </Text>
              {item.executedquantity && (
                <Text style={stylesheet.volume}>Vol: {item.executedquantity}</Text>
              )}
            </View>
          </View>
        ))
      )}
    </ScrollView>
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: theme.colors.text.primary,
    marginBottom: 16,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: theme.colors.text.secondary,
  },
  emptyText: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    padding: 24,
  },
  priceCard: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceLeft: {
    flex: 1,
  },
  priceRight: {
    alignItems: 'flex-end',
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
  },
  price: {
    fontSize: 18,
    fontWeight: 'bold',
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  change: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  changePositive: {
    color: '#10b981',
  },
  changeNegative: {
    color: '#ef4444',
  },
  changeNeutral: {
    color: theme.colors.text.secondary,
  },
  volume: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
}));
