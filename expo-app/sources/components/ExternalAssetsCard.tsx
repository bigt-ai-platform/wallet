import * as React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { EXTERNAL_ASSETS } from '@/lib/externalAssets';
import { mergeExternalBalances, type ExternalPortfolioRow } from '@/lib/externalPortfolio';
import {
  distributorAccount,
  getExternalBalances,
  isDistributorConfigured,
} from '@/services/distributor';

/**
 * Compact external-asset summary for the home screen.
 *
 * Renders **nothing** unless a distributor is configured and at least one
 * balance is non-zero, so a wallet that does not use this rail is unchanged.
 * Tapping opens `/external-asset`, which owns deposit/transfer/redeem.
 */
export default function ExternalAssetsCard() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { publicInfo } = useWallet();
  const [rows, setRows] = React.useState<ExternalPortfolioRow[]>([]);

  const walletAddress = publicInfo?.address ?? '';

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!walletAddress || !isDistributorConfigured()) {
        setRows([]);
        return;
      }
      try {
        const balances = await getExternalBalances(distributorAccount(walletAddress));
        if (!cancelled) {
          setRows(mergeExternalBalances(EXTERNAL_ASSETS, balances, i18n.language || 'en'));
        }
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, i18n.language]);

  if (rows.length === 0) return null;

  return (
    <TouchableOpacity
      style={s.card}
      onPress={() => router.push('/external-asset' as never)}
      accessibilityRole="button"
      testID="home-external-assets"
    >
      <View style={s.header}>
        <Text style={s.title}>{t('extAsset.title')}</Text>
        <Text style={s.chevron}>›</Text>
      </View>
      {rows.map((row) => (
        <View key={row.asset.id} style={s.row} testID={`home-external-${row.asset.id}`}>
          <Text style={s.symbol}>{row.symbol}</Text>
          <Text style={s.amount}>{row.amount}</Text>
        </View>
      ))}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chevron: { fontSize: 18, color: theme.colors.text.secondary },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8 },
  symbol: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  amount: { fontSize: 14, color: theme.colors.text.primary },
}));
