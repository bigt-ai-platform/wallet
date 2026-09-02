import * as React from 'react';
import { View, Text, TextInput, Switch, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { MONO_FONT } from '@/constants/fonts';
import { APP_VERSION, DEFAULT_L1_CHAINS_MAINNET, DEFAULT_L1_CHAINS_TESTNET } from '@/constants/app';
import ChainBadge from '@/components/ChainBadge';
import type { L1ChainConfig } from '@/types/api';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const [useTestnet, setUseTestnet] = React.useState(() => {
    const stored = (httpService as any).getServerUrl?.();
    return stored?.includes('test') ?? false;
  });
  const [serverUrl, setServerUrl] = React.useState(httpService.getServerUrl());
  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  const [activeChainId, setActiveChainId] = React.useState(() => httpService.getActiveL1ChainId());
  const [showDev, setShowDev] = React.useState(false);
  // Moved here from the Transaction tab: the L1 bridge/withdraw test harness.
  const [l1TestToken, setL1TestToken] = React.useState('');
  const [l1TestAmount, setL1TestAmount] = React.useState('');
  const [l1TestDest, setL1TestDest] = React.useState('');
  const [l1TestSub, setL1TestSub] = React.useState(false);
  const [l1TestMode, setL1TestMode] = React.useState<'pay' | 'payback'>('pay');
  const [newChainId, setNewChainId] = React.useState('');
  const [newChainName, setNewChainName] = React.useState('');
  const [newChainUrl, setNewChainUrl] = React.useState('');

  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Chains(httpService.getL1Chains());
    setActiveChainId(httpService.getActiveL1ChainId());
  }), []);
  const appVersion = APP_VERSION;

  const toggleTestnet = (val: boolean) => {
    setUseTestnet(val);
    httpService.setTestnet(val);
    setServerUrl(httpService.getDefaultServerUrl());
  };

  const saveServer = () => {
    if (!serverUrl.trim()) { Alert.alert('', t('settings.urlEmpty')); return; }
    httpService.setServerUrl(serverUrl.trim());
    Alert.alert(t('settings.saved'), t('settings.serverUpdated'));
  };

  const chainErrMsg = (code: string | null, id?: string): string => {
    switch (code) {
      case 'chainIdEmpty': return t('settings.chainIdEmpty');
      case 'chainIdReserved': return t('settings.chainIdReserved');
      case 'chainIdExists': return t('settings.chainIdExists', { id: id || '' });
      case 'chainNotFound': return t('settings.noL1Chains');
      default: return code || '';
    }
  };

  const addL1Chain = () => {
    if (!newChainName.trim()) { Alert.alert('', t('settings.errNameEmpty')); return; }
    if (!newChainUrl.trim()) { Alert.alert('', t('settings.errUrlEmpty')); return; }
    const err = httpService.addL1Chain(newChainId, newChainName, newChainUrl);
    if (err) { Alert.alert('', chainErrMsg(err, newChainId)); return; }
    setL1Chains(httpService.getL1Chains());
    setNewChainId('');
    setNewChainName('');
    setNewChainUrl('');
  };

  const removeL1Chain = (index: number) => {
    httpService.removeL1Chain(index);
    setL1Chains(httpService.getL1Chains());
    setActiveChainId(httpService.getActiveL1ChainId());
  };

  const saveL1Chain = (index: number, chainId: string, name: string, url: string) => {
    const err = httpService.updateL1Chain(index, chainId, name, url);
    if (err) { Alert.alert('', chainErrMsg(err, chainId)); }
    setL1Chains(httpService.getL1Chains());
    setActiveChainId(httpService.getActiveL1ChainId());
  };

  const updateChainName = (index: number, name: string) => {
    const updated = l1Chains.map((c, i) => i === index ? { ...c, name } : c);
    setL1Chains(updated);
    saveL1Chain(index, updated[index].chainId, name, updated[index].url);
  };

  const updateChainUrl = (index: number, url: string) => {
    const updated = l1Chains.map((c, i) => i === index ? { ...c, url } : c);
    setL1Chains(updated);
    saveL1Chain(index, updated[index].chainId, updated[index].name, url);
  };

  const updateChainId = (index: number, chainId: string) => {
    const updated = l1Chains.map((c, i) => i === index ? { ...c, chainId } : c);
    setL1Chains(updated);
    saveL1Chain(index, chainId, updated[index].name, updated[index].url);
  };

  const handlePayL1 = async () => {
    if (!l1TestToken.trim()) { Alert.alert('', t('settings.errEnterToken')); return; }
    if (!l1TestAmount || parseFloat(l1TestAmount) <= 0) { Alert.alert('', t('settings.errAmount')); return; }
    if (!l1TestDest.trim()) { Alert.alert('', t('settings.errL1Dest')); return; }

    setL1TestSub(true);
    try {
      const payload = {
        tokenid: l1TestToken.trim(),
        amount: l1TestAmount,
        l1address: l1TestDest.trim(),
        fromAddress: undefined,
      };
      const res = await httpService.request('regSubtangle', 'POST', payload);
      if (res.success) {
        Alert.alert(t('keys.successHead'), t('settings.bridged', { amount: l1TestAmount }));
        setL1TestAmount(''); setL1TestDest('');
      } else {
        Alert.alert(t('keys.errorHead'), res.error || t('settings.bridgeFailed'));
      }
    } catch (e: any) {
      Alert.alert(t('keys.errorHead'), e.message);
    } finally {
      setL1TestSub(false);
    }
  };

  const handlePayBackL1 = async () => {
    if (!l1TestToken.trim()) { Alert.alert('', t('settings.errEnterToken')); return; }
    if (!l1TestAmount || parseFloat(l1TestAmount) <= 0) { Alert.alert('', t('settings.errAmount')); return; }
    if (!l1TestDest.trim()) { Alert.alert('', t('settings.errL0Dest')); return; }

    const chain = l1Chains.find((c) => c.chainId === activeChainId);
    if (!chain) { Alert.alert(t('keys.errorHead'), t('order.noL1')); return; }

    setL1TestSub(true);
    try {
      const payload = {
        tokenid: l1TestToken.trim(),
        amount: l1TestAmount,
        toAddress: l1TestDest.trim(),
        fromAddress: undefined,
      };
      const res = await httpService.requestL1ByChainId(activeChainId, 'withdrawTransaction', 'POST', payload);
      if (res.success) {
        Alert.alert(t('keys.successHead'), t('settings.withdrawalInitiated', { amount: l1TestAmount }));
        setL1TestAmount(''); setL1TestDest('');
      } else {
        Alert.alert(t('keys.errorHead'), res.error || t('settings.withdrawalFailed'));
      }
    } catch (e: any) {
      Alert.alert(t('keys.errorHead'), e.message);
    } finally {
      setL1TestSub(false);
    }
  };

  const resetDefaults = () => {
    setUseTestnet(false);
    httpService.setTestnet(false);
    httpService.setServerUrl(httpService.getDefaultServerUrl());
    httpService.setL1Chains(DEFAULT_L1_CHAINS_TESTNET.slice());
    httpService.setActiveL1ChainId(DEFAULT_L1_CHAINS_TESTNET[0].chainId);
    setL1Chains(httpService.getL1Chains());
    setActiveChainId(httpService.getActiveL1ChainId());
    setServerUrl(httpService.getDefaultServerUrl());
    Alert.alert('', t('settings.resetDone'));
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} testID="settings-screen">
      <Text style={s.pageTitle}>{t('settings.title')}</Text>

      <View style={s.card}>
        <View style={s.settingRow}>
          <View style={s.settingLeft}>
            <Text style={s.settingLabel}>{t('settings.testnet')}</Text>
            <Text style={s.settingDesc}>{t('settings.testnetDesc')}</Text>
          </View>
          <Switch value={useTestnet} onValueChange={toggleTestnet}
            trackColor={{ false: s.switchOff.color, true: s.switchOn.color }}
            thumbColor={useTestnet ? s.switchThumb.color : '#f4f3f4'} testID="testnet-toggle" />
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.cardLabel}>{t('settings.serverUrl')}</Text>
        <TextInput style={s.input} value={serverUrl} onChangeText={setServerUrl}
          placeholder="https://..." placeholderTextColor={s.placeholder.color}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="server-url-input" />
        <TouchableOpacity style={s.saveBtn} onPress={saveServer}>
          <Text style={s.saveBtnText}>{t('settings.save')}</Text>
        </TouchableOpacity>
      </View>

      <View style={s.card}>
        <Text style={s.cardLabel}>{t('settings.l1Chains')}</Text>
        <Text style={s.settingDesc}>{t('settings.l1ChainsDesc')}</Text>

        {l1Chains.map((chain, i) => (
          <TouchableOpacity key={chain.chainId} style={[s.chainRow, activeChainId === chain.chainId && s.chainRowActive]}
            onPress={() => httpService.setActiveL1ChainId(chain.chainId)} testID={`l1-chain-row-${i}`}>
            <View style={s.chainRadio}>{activeChainId === chain.chainId && <View style={s.chainRadioDot} />}</View>
            <View style={s.chainFields}>
              <TextInput style={s.chainInput} value={chain.name}
                onChangeText={(v) => updateChainName(i, v)}
                placeholder={t('settings.namePh')} placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" />
              <TextInput style={s.chainInput} value={chain.chainId}
                onChangeText={(v) => updateChainId(i, v)}
                placeholder={t('settings.chainIdPh')} placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" autoCorrect={false} />
              <TextInput style={s.chainInput} value={chain.url}
                onChangeText={(v) => updateChainUrl(i, v)}
                placeholder="https://..." placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            </View>
            <ChainBadge layer={1} name={t('settings.active')} />
            <TouchableOpacity style={s.removeBtn} onPress={() => removeL1Chain(i)}>
              <Text style={s.removeBtnText}>X</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}

        <View style={s.addChainRow}>
          <TextInput style={s.chainInputSmall} value={newChainId}
            onChangeText={setNewChainId} placeholder={t('settings.chainIdAddPh')} placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" autoCorrect={false} testID="new-chain-id-input" />
          <TextInput style={s.chainInputSmall} value={newChainName}
            onChangeText={setNewChainName} placeholder={t('settings.namePh')} placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" />
          <TextInput style={s.chainInputSmall} value={newChainUrl}
            onChangeText={setNewChainUrl} placeholder="https://..." placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <TouchableOpacity style={s.addBtn} onPress={addL1Chain}>
            <Text style={s.addBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.cardLabel}>{t('settings.about')}</Text>
        <View style={s.aboutRow}>
          <Text style={s.aboutLabel}>{t('settings.appVersion')}</Text>
          <Text style={s.aboutValue}>{appVersion}</Text>
        </View>
        <View style={s.aboutRow}>
          <Text style={s.aboutLabel}>{t('settings.network')}</Text>
          <Text style={s.aboutValue}>{useTestnet ? t('settings.testnet_') : t('settings.mainnet')}</Text>
        </View>
      </View>

      <View style={s.card}>
        <TouchableOpacity style={s.settingRow} onPress={() => setShowDev(!showDev)} testID="developer-toggle">
          <View style={s.settingLeft}>
            <Text style={s.settingLabel}>{t('settings.dev')}</Text>
            <Text style={s.settingDesc}>{t('settings.devDesc')}</Text>
          </View>
          <Text style={s.devChevron}>{showDev ? '▾' : '▸'}</Text>
        </TouchableOpacity>

        {showDev && (
          <>
            <Text style={s.settingDesc} testID="l1-test-desc">
              {t('settings.payDesc')}
            </Text>
            <View style={[s.card, s.devInner]}>
              <Text style={s.cardLabel}>{t('settings.selectL1Chain')}</Text>
              {l1Chains.length === 0 ? (
                <Text style={s.settingDesc}>{t('settings.noL1Chains')}</Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} testID="l1-chain-list">
                  {l1Chains.map((chain, i) => (
                    <TouchableOpacity key={chain.chainId} style={[s.tokenChip, activeChainId === chain.chainId && s.tokenChipActive]}
                      onPress={() => httpService.setActiveL1ChainId(chain.chainId)} testID={`l1-chain-chip-${i}`}>
                      <ChainBadge layer={1} />
                      <Text style={[s.tokenChipName, activeChainId === chain.chainId && s.tokenChipNameActive]}>{chain.name}</Text>
                      <Text style={[s.tokenChipBal, activeChainId === chain.chainId && s.tokenChipBalActive]}>{chain.chainId} · {chain.url}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            <View style={s.modeRow} testID="l1-mode-tabs">
              <TouchableOpacity style={[s.modeTab, l1TestMode === 'pay' && s.modeTabActive]} onPress={() => setL1TestMode('pay')} testID="l1-mode-pay">
                <Text style={[s.modeTabText, l1TestMode === 'pay' && s.modeTabTextActive]}>{t('settings.payMode')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modeTab, l1TestMode === 'payback' && s.modeTabActive]} onPress={() => setL1TestMode('payback')} testID="l1-mode-payback">
                <Text style={[s.modeTabText, l1TestMode === 'payback' && s.modeTabTextActive]}>{t('settings.paybackMode')}</Text>
              </TouchableOpacity>
            </View>

            {l1TestMode === 'pay' ? (
              <View style={[s.card, s.devInner]} testID="l1-pay-section">
                <Text style={s.sectionLabel}>{t('settings.paySection')}</Text>
                <Text style={s.settingDesc}>{t('settings.paySectionDesc')}</Text>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldTokenId')}</Text>
                  <TextInput style={s.input} value={l1TestToken} onChangeText={setL1TestToken}
                    placeholder={t('settings.bcPh')} placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-pay-token-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldAmount')}</Text>
                  <TextInput style={s.input} value={l1TestAmount} onChangeText={setL1TestAmount}
                    placeholder="0.00" keyboardType="decimal-pad" testID="l1-pay-amount-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldL1Dest')}</Text>
                  <TextInput style={s.input} value={l1TestDest} onChangeText={setL1TestDest}
                    placeholder={t('settings.l1DestPh')} placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-pay-dest-input" />
                </View>
                <TouchableOpacity style={s.l1Btn} onPress={handlePayL1} disabled={l1TestSub} testID="l1-pay-button">
                  <Text style={s.l1BtnText}>{l1TestSub ? t('settings.processing') : t('settings.payL1Btn')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[s.card, s.devInner]} testID="l1-payback-section">
                <Text style={s.sectionLabel}>{t('settings.paybackSection')}</Text>
                <Text style={s.settingDesc}>{t('settings.paybackDesc')}</Text>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldTokenId')}</Text>
                  <TextInput style={s.input} value={l1TestToken} onChangeText={setL1TestToken}
                    placeholder={t('settings.bcPh')} placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-payback-token-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldAmount')}</Text>
                  <TextInput style={s.input} value={l1TestAmount} onChangeText={setL1TestAmount}
                    placeholder="0.00" keyboardType="decimal-pad" testID="l1-payback-amount-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>{t('settings.fieldL0Dest')}</Text>
                  <TextInput style={s.input} value={l1TestDest} onChangeText={setL1TestDest}
                    placeholder={t('settings.l0DestPh')} placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-payback-dest-input" />
                </View>
                <TouchableOpacity style={s.l1Btn} onPress={handlePayBackL1} disabled={l1TestSub} testID="l1-payback-button">
                  <Text style={s.l1BtnText}>{l1TestSub ? t('settings.processing') : t('settings.paybackBtn')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </View>

      <TouchableOpacity style={s.resetBtn} onPress={resetDefaults} testID="reset-settings-button">
        <Text style={s.resetBtnText}>{t('settings.reset')}</Text>
      </TouchableOpacity>

      <Text style={s.footer}>bigt.ai v{appVersion}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  card: {
    backgroundColor: theme.colors.card?.background ?? theme.colors.groupped.surface, borderRadius: 12,
    borderWidth: 1, borderColor: theme.colors.card?.border ?? theme.colors.border, padding: 16, marginBottom: 12,
  },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  settingLeft: { flex: 1, marginRight: 12 },
  settingLabel: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  settingDesc: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 8 },
  switchOff: { color: theme.colors.border },
  switchOn: { color: theme.colors.primary },
  switchThumb: { color: '#FFFFFF' },
  input: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary,
    padding: 12, fontSize: 15, fontFamily: MONO_FONT,
  },
  placeholder: { color: theme.colors.text.secondary },
  saveBtn: {
    backgroundColor: theme.colors.primary, borderRadius: 10,
    paddingVertical: 15, alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  aboutLabel: { fontSize: 14, color: theme.colors.text.secondary },
  aboutValue: { fontSize: 14, fontWeight: '600', color: theme.colors.text.primary },
  resetBtn: {
    borderRadius: 10, borderWidth: 1, borderColor: theme.colors.accent.red,
    paddingVertical: 15, alignItems: 'center', marginTop: 8,
  },
  resetBtnText: { fontSize: 16, fontWeight: '600', color: theme.colors.accent.red },
  footer: { fontSize: 12, color: theme.colors.text.secondary, textAlign: 'center', marginTop: 20 },
  chainRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  chainFields: { flex: 1, gap: 4 },
  chainInput: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6,
    backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary,
    padding: 8, fontSize: 13, fontFamily: MONO_FONT,
  },
  chainInputSmall: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6,
    backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary,
    padding: 8, fontSize: 13, fontFamily: MONO_FONT, flex: 1,
  },
  removeBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: theme.colors.accent.red,
    justifyContent: 'center', alignItems: 'center',
  },
  removeBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  addChainRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  addBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.primary,
    justifyContent: 'center', alignItems: 'center',
  },
  addBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 18 },
  chainRowActive: { borderColor: theme.colors.primary, borderRadius: 8, borderWidth: 1, padding: 4 },
  chainRadio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2,
    borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center',
  },
  chainRadioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary },
  devChevron: { fontSize: 14, color: theme.colors.text.secondary },
  devInner: { marginTop: 10, marginBottom: 8 },
  tokenChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.groupped.background, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' },
  tokenChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tokenChipName: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginTop: 2 },
  tokenChipNameActive: { color: '#FFFFFF' },
  tokenChipBal: { fontSize: 10, color: theme.colors.text.secondary },
  tokenChipBalActive: { color: '#FFFFFF', opacity: 0.85 },
  modeRow: { flexDirection: 'row', marginBottom: 10, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  modeTab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  modeTabActive: { backgroundColor: theme.colors.accent.purple },
  modeTabText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary },
  modeTabTextActive: { color: '#FFFFFF' },
  fieldGroup: { marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  sectionLabel: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 4 },
  l1Btn: { backgroundColor: theme.colors.accent.purple, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  l1BtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
}));
