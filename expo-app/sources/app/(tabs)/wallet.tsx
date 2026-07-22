import * as React from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { CloseIcon } from '@/components/Icons';
import type { WalletAccountItem } from '@/types/api';

export default function WalletScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { publicInfo, isUnlocked } = useWallet();
  const [assets, setAssets] = React.useState<WalletAccountItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'assets' | 'bridge'>('assets');

  // Bridge form
  const [bridgeToken, setBridgeToken] = React.useState('');
  const [bridgeAmount, setBridgeAmount] = React.useState('');
  const [bridgeDest, setBridgeDest] = React.useState('');
  const [bridgeSub, setBridgeSub] = React.useState(false);

  React.useEffect(() => {
    if (publicInfo && isUnlocked) loadAssets();
  }, [publicInfo, isUnlocked]);

  const loadAssets = async (isRefresh = false) => {
    if (!publicInfo?.address) return;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await httpService.getBalances(publicInfo.address);
      if (res.success && res.data) setAssets(res.data);
    } catch (e) { console.error('Error loading assets:', e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const handleBridge = async () => {
    if (!bridgeToken.trim()) { Alert.alert('Error', 'Select a token'); return; }
    if (!bridgeAmount || parseFloat(bridgeAmount) <= 0) { Alert.alert('Error', 'Enter amount'); return; }
    if (!bridgeDest.trim()) { Alert.alert('Error', 'Enter L1 destination address'); return; }
    setBridgeSub(true);
    try {
      const payload = { tokenid: bridgeToken, amount: bridgeAmount, l1address: bridgeDest.trim(), fromAddress: publicInfo?.address };
      const res = await httpService.request('regSubtangle', 'POST', payload);
      if (res.success) {
        Alert.alert('Transfer Initiated', `Cross-chain transfer of ${bridgeAmount} to L1 order chain submitted`);
        setBridgeAmount(''); setBridgeDest('');
      } else {
        Alert.alert('Error', res.error || 'Transfer failed');
      }
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setBridgeSub(false); }
  };

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="wallet-screen">
        <View style={s.centered}>
          <Text style={s.lockedTitle}>{t('wallet.locked')}</Text>
          <Text style={s.lockedSub}>{t('wallet.lockedSub')}</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/wallet/keys')}>
            <Text style={s.primaryBtnText}>{t('wallet.manageWallet')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="wallet-screen">
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, activeTab === 'assets' && s.tabActive]} onPress={() => setActiveTab('assets')}>
          <Text style={[s.tabText, activeTab === 'assets' && s.tabTextActive]}>Assets</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'bridge' && s.tabActive]} onPress={() => setActiveTab('bridge')}>
          <Text style={[s.tabText, activeTab === 'bridge' && s.tabTextActive]}>Bridge → L1</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'assets' ? (
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.addressCard}>
            <Text style={s.addressLabel}>{t('wallet.yourAddress')}</Text>
            <Text style={s.address} testID="wallet-address" selectable>{publicInfo?.address}</Text>
            <View style={s.addressDivider} />
            <TouchableOpacity onPress={() => router.push('/wallet/keys')}>
              <Text style={s.manageLink}>{t('wallet.manageKeys')}</Text>
            </TouchableOpacity>
          </View>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>{t('wallet.assets')}</Text>
            <TouchableOpacity onPress={() => loadAssets(true)} disabled={refreshing}>
              <Text style={s.refreshBtn}>{refreshing ? '...' : t('wallet.refresh')}</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 24 }} />
          ) : assets.length === 0 ? (
            <Text style={s.emptyText}>{t('wallet.noAssets')}</Text>
          ) : (
            assets.map((asset) => (
              <View key={asset.tokenid} style={s.assetCard}>
                <View style={s.assetLeft}>
                  <View style={s.assetDot} />
                  <View>
                    <Text style={s.assetName}>{asset.tokenname}</Text>
                    <Text style={s.assetId}>{asset.tokenid.slice(0, 12)}...</Text>
                  </View>
                </View>
                <Text style={s.assetBalance}>{asset.balance}</Text>
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.formTitle}>Bridge to L1 Order Chain</Text>
          <Text style={s.formSub}>Transfer tokens from Layer 0 to the L1 Order Match chain. Tokens will be locked on L0 and wrapped tokens issued on L1.</Text>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>Token ID</Text>
            <TextInput style={s.fieldInput} value={bridgeToken} onChangeText={setBridgeToken}
              placeholder="e.g. bc for BIG" placeholderTextColor={s.placeholder.color} autoCapitalize="none" />
            {assets.length > 0 && (
              <ScrollView horizontal style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
                {assets.slice(0, 5).map((a) => (
                  <TouchableOpacity key={a.tokenid} style={s.chip} onPress={() => setBridgeToken(a.tokenid)}>
                    <Text style={s.chipText}>{a.tokenname}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>Amount</Text>
            <TextInput style={s.fieldInput} value={bridgeAmount} onChangeText={setBridgeAmount}
              placeholder="0.00" keyboardType="decimal-pad" />
          </View>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>L1 Destination Address</Text>
            <TextInput style={s.fieldInput} value={bridgeDest} onChangeText={setBridgeDest}
              placeholder="L1 address on order chain" placeholderTextColor={s.placeholder.color} autoCapitalize="none" />
          </View>

          <TouchableOpacity style={s.bridgeBtn} onPress={handleBridge} disabled={bridgeSub}>
            <Text style={s.bridgeBtnText}>{bridgeSub ? 'Bridging...' : 'Bridge to L1'}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8 },
  lockedSub: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
  tabTextActive: { color: '#FFFFFF' },
  addressCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 16, marginBottom: 20 },
  addressLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  address: { fontSize: 13, color: theme.colors.text.primary, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), lineHeight: 18 },
  addressDivider: { height: 1, backgroundColor: theme.colors.divider, marginVertical: 12 },
  manageLink: { fontSize: 14, color: theme.colors.primary, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary },
  refreshBtn: { fontSize: 14, color: theme.colors.primary, fontWeight: '600' },
  loader: { color: theme.colors.primary },
  emptyText: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', padding: 24 },
  assetCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  assetLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  assetDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary },
  assetName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  assetId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: 'monospace' },
  assetBalance: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary },
  primaryBtn: { backgroundColor: theme.colors.primary, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center' },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  formTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  formSub: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 18, marginBottom: 20 },
  fieldGroup: { marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15 },
  placeholder: { color: theme.colors.text.secondary },
  chip: { backgroundColor: theme.colors.groupped.background, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.primary },
  bridgeBtn: { backgroundColor: theme.colors.accent?.purple || '#8B5CF6', borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  bridgeBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
}));
