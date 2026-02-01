/**
 * Wallet Screen
 *
 * Shows wallet balance and asset management
 */

import * as React from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import type { WalletAccountItem } from '@/types/api';

export default function WalletScreen() {
  
  const router = useRouter();
  const { publicInfo, isUnlocked } = useWallet();

  const [assets, setAssets] = React.useState<WalletAccountItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (publicInfo && isUnlocked) {
      loadAssets();
    }
  }, [publicInfo, isUnlocked]);

  const loadAssets = async (isRefresh = false) => {
    if (!publicInfo?.address) return;

    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await httpService.getBalances(publicInfo.address);
      if (response.success && response.data) {
        setAssets(response.data);
      }
    } catch (error) {
      console.error('Error loading assets:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    loadAssets(true);
  };

  if (!isUnlocked) {
    return (
      <View style={stylesheet.container}>
        <View style={stylesheet.centered}>
          <Text style={stylesheet.subtitle}>Please unlock your wallet</Text>
          <TouchableOpacity
            style={stylesheet.button}
            onPress={() => router.push('/wallet/keys')}
          >
            <Text style={stylesheet.buttonText}>Manage Wallet</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={stylesheet.container} contentContainerStyle={stylesheet.content}>
      {/* Wallet Address */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.label}>Your Address</Text>
        <Text style={stylesheet.address}>{publicInfo?.address}</Text>
      </View>

      {/* Assets */}
      <View style={stylesheet.section}>
        <View style={stylesheet.sectionHeader}>
          <Text style={stylesheet.label}>Assets</Text>
          <TouchableOpacity onPress={handleRefresh} disabled={refreshing}>
            <Text style={stylesheet.refreshText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator size="large" />
        ) : assets.length === 0 ? (
          <Text style={stylesheet.emptyText}>No assets found</Text>
        ) : (
          assets.map((asset) => (
            <View key={asset.tokenid} style={stylesheet.assetCard}>
              <View>
                <Text style={stylesheet.assetName}>{asset.tokenname}</Text>
                <Text style={stylesheet.assetId}>{asset.tokenid.substring(0, 16)}...</Text>
              </View>
              <View style={stylesheet.assetRight}>
                <Text style={stylesheet.assetBalance}>{asset.balance}</Text>
                {asset.confirmedBalance !== asset.balance && (
                  <Text style={stylesheet.assetPending}>
                    Pending: {(parseFloat(asset.balance) - parseFloat(asset.confirmedBalance)).toFixed(asset.decimals)}
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
      </View>

      {/* Actions */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.label}>Actions</Text>
        <TouchableOpacity
          style={stylesheet.actionButton}
          onPress={() => router.push('/wallet/keys')}
        >
          <Text style={stylesheet.actionButtonText}>Manage Keys</Text>
        </TouchableOpacity>
      </View>
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
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: theme.colors.text.secondary,
    marginBottom: 16,
    textAlign: 'center',
  },
  address: {
    fontSize: 14,
    color: theme.colors.text.primary,
    fontFamily: 'monospace',
    backgroundColor: theme.colors.groupped.surface,
    padding: 12,
    borderRadius: 8,
  },
  refreshText: {
    fontSize: 14,
    color: theme.colors.primary,
  },
  emptyText: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    padding: 24,
  },
  assetCard: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  assetName: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  assetId: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    fontFamily: 'monospace',
  },
  assetRight: {
    alignItems: 'flex-end',
  },
  assetBalance: {
    fontSize: 18,
    fontWeight: 'bold',
    color: theme.colors.text.primary,
  },
  assetPending: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    marginTop: 2,
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    minWidth: 200,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  actionButton: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.primary,
  },
}));
