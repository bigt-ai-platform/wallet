import * as React from 'react';
import { View, Text, TextInput, ScrollView, ActivityIndicator, TouchableOpacity, Alert, Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { CloseIcon } from '@/components/Icons';
import type { TokenItem } from '@/types/api';

export default function TokensScreen() {
  const { t } = useTranslation();
  const { publicInfo, isUnlocked } = useWallet();
  const [tokens, setTokens] = React.useState<TokenItem[]>([]);
  const [filtered, setFiltered] = React.useState<TokenItem[]>([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [activeTab, setActiveTab] = React.useState<'browse' | 'create'>('browse');

  // Create form state
  const [showCreate, setShowCreate] = React.useState(false);
  const [tokenName, setTokenName] = React.useState('');
  const [tokenSymbol, setTokenSymbol] = React.useState('');
  const [tokenDecimals, setTokenDecimals] = React.useState('6');
  const [tokenSupply, setTokenSupply] = React.useState('1000000');
  const [tokenDesc, setTokenDesc] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => { loadTokens(); }, []);

  const loadTokens = async () => {
    setLoading(true);
    try {
      const res = await httpService.getTokensItemList();
      if (res.success && res.data) { setTokens(res.data); setFiltered(res.data); }
    } catch (e) { console.error('Error loading tokens:', e); }
    finally { setLoading(false); }
  };

  const onSearch = (text: string) => {
    setSearch(text);
    if (!text.trim()) { setFiltered(tokens); return; }
    const q = text.toLowerCase();
    setFiltered(tokens.filter(t => t.tokenname?.toLowerCase().includes(q) || t.tokenid?.toLowerCase().includes(q)));
  };

  const handleCreate = async () => {
    if (!tokenName.trim()) { Alert.alert('Error', 'Token name is required'); return; }
    if (!tokenSymbol.trim()) { Alert.alert('Error', 'Token symbol is required'); return; }
    const decimals = parseInt(tokenDecimals);
    if (isNaN(decimals) || decimals < 0 || decimals > 18) { Alert.alert('Error', 'Decimals must be 0-18'); return; }
    const supply = parseFloat(tokenSupply);
    if (isNaN(supply) || supply <= 0) { Alert.alert('Error', 'Supply must be > 0'); return; }

    setCreating(true);
    try {
      const payload = {
        name: tokenName.trim(),
        symbol: tokenSymbol.trim().toLowerCase(),
        decimals,
        supply: Math.floor(supply * Math.pow(10, decimals)).toString(),
        description: tokenDesc.trim(),
        address: publicInfo?.address || '',
      };
      const res = await httpService.request('signToken', 'POST', payload);
      if (res.success) {
        Alert.alert('Token Created', `${tokenName} (${tokenSymbol}) has been created on the blockchain`);
        setShowCreate(false); setTokenName(''); setTokenSymbol(''); setTokenDesc('');
        loadTokens();
      } else {
        Alert.alert('Error', res.error || 'Failed to create token');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to create token');
    } finally { setCreating(false); }
  };

  if (loading) {
    return (
      <View style={s.container} testID="tokens-screen">
        <View style={s.centered}><ActivityIndicator size="large" color={s.loader.color} /></View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="tokens-screen">
      {/* Tab bar */}
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, activeTab === 'browse' && s.tabActive]} onPress={() => setActiveTab('browse')}>
          <Text style={[s.tabText, activeTab === 'browse' && s.tabTextActive]}>{t('tokens.title')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'create' && s.tabActive]} onPress={() => setActiveTab('create')}>
          <Text style={[s.tabText, activeTab === 'create' && s.tabTextActive]}>Create</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'browse' ? (
        <>
          <View style={s.searchRow}>
            <TextInput style={s.searchInput} value={search} onChangeText={onSearch}
              placeholder={t('tokens.search')} placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="token-search-input" />
          </View>
          <ScrollView contentContainerStyle={s.listContent}>
            <Text style={s.listTitle}>{tokens.length} tokens</Text>
            {filtered.length === 0 ? (
              <View style={s.emptyCard}>
                <Text style={s.emptyTitle}>{search ? t('tokens.noMatches') : t('tokens.noTokens')}</Text>
              </View>
            ) : (
              filtered.map((token, i) => (
                <View key={token.tokenid || i} style={s.tokenCard} testID={`token-card-${i}`}>
                  <View style={s.tokenDot} />
                  <View style={s.tokenInfo}>
                    <Text style={s.tokenName}>{token.tokenname || 'Unknown'}</Text>
                    <Text style={s.tokenId}>{token.tokenid ? token.tokenid.slice(0, 16) + '...' : ''}</Text>
                    {token.description ? <Text style={s.tokenDesc} numberOfLines={1}>{token.description}</Text> : null}
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </>
      ) : (
        <ScrollView contentContainerStyle={s.formContent}>
          <Text style={s.formTitle}>Create New Token</Text>
          <Text style={s.formSub}>Issue a new token on the blockchain, like USDC or your own custom token.</Text>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>Token Name</Text>
            <TextInput style={s.fieldInput} value={tokenName} onChangeText={setTokenName}
              placeholder="e.g. USD Coin" placeholderTextColor={s.placeholder.color} />
          </View>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>Symbol / Ticker</Text>
            <TextInput style={s.fieldInput} value={tokenSymbol} onChangeText={setTokenSymbol}
              placeholder="e.g. USDC" placeholderTextColor={s.placeholder.color}
              autoCapitalize="characters" />
          </View>

          <View style={s.fieldRow}>
            <View style={[s.fieldGroup, { flex: 1, marginRight: 8 }]}>
              <Text style={s.fieldLabel}>Decimals</Text>
              <TextInput style={s.fieldInput} value={tokenDecimals} onChangeText={setTokenDecimals}
                placeholder="6" keyboardType="number-pad" />
            </View>
            <View style={[s.fieldGroup, { flex: 2 }]}>
              <Text style={s.fieldLabel}>Initial Supply</Text>
              <TextInput style={s.fieldInput} value={tokenSupply} onChangeText={setTokenSupply}
                placeholder="1000000" keyboardType="decimal-pad" />
            </View>
          </View>

          <View style={s.fieldGroup}>
            <Text style={s.fieldLabel}>Description (optional)</Text>
            <TextInput style={[s.fieldInput, s.fieldArea]} value={tokenDesc} onChangeText={setTokenDesc}
              placeholder="Describe your token" placeholderTextColor={s.placeholder.color}
              multiline numberOfLines={3} />
          </View>

          <TouchableOpacity style={s.createBtn} onPress={handleCreate} disabled={creating}>
            <Text style={s.createBtnText}>{creating ? 'Creating...' : 'Create Token'}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loader: { color: theme.colors.primary },
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
  tabTextActive: { color: '#FFFFFF' },
  searchRow: { paddingHorizontal: 16, paddingTop: 12 },
  searchInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
  listContent: { padding: 16 },
  listTitle: { fontSize: 13, color: theme.colors.text.secondary, marginBottom: 12 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 32, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: theme.colors.text.secondary },
  tokenCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  tokenDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent?.blue || '#3B82F6', marginRight: 12 },
  tokenInfo: { flex: 1 },
  tokenName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  tokenId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: 'monospace', marginBottom: 2 },
  tokenDesc: { fontSize: 12, color: theme.colors.text.secondary },
  formContent: { padding: 16, paddingBottom: 40 },
  formTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  formSub: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 18, marginBottom: 20 },
  fieldGroup: { marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15 },
  fieldArea: { minHeight: 72, textAlignVertical: 'top' },
  fieldRow: { flexDirection: 'row' },
  createBtn: { backgroundColor: theme.colors.accent?.blue || '#3B82F6', borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  createBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
}));
