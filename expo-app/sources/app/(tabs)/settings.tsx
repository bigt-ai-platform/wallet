import * as React from 'react';
import { View, Text, TextInput, Switch, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { MONO_FONT } from '@/constants/fonts';
import type { L1ChainConfig } from '@/types/api';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const [useTestnet, setUseTestnet] = React.useState(() => {
    const stored = (httpService as any).getServerUrl?.();
    return stored?.includes('test') ?? false;
  });
  const [serverUrl, setServerUrl] = React.useState(httpService.getServerUrl());
  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  const [newChainName, setNewChainName] = React.useState('');
  const [newChainUrl, setNewChainUrl] = React.useState('');
  const appVersion = '1.2.0';

  const toggleTestnet = (val: boolean) => {
    setUseTestnet(val);
    httpService.setTestnet(val);
    if (val) {
      setServerUrl('https://testp.bigtangle.org:8088/');
    } else {
      setServerUrl('https://p.bigtangle.org:8088/');
    }
  };

  const saveServer = () => {
    if (!serverUrl.trim()) { Alert.alert('', t('settings.urlEmpty')); return; }
    httpService.setServerUrl(serverUrl.trim());
    Alert.alert(t('settings.saved'), t('settings.serverUpdated'));
  };

  const addL1Chain = () => {
    if (!newChainName.trim()) { Alert.alert('', 'Chain name cannot be empty'); return; }
    if (!newChainUrl.trim()) { Alert.alert('', 'Chain URL cannot be empty'); return; }
    httpService.addL1Chain(newChainName.trim(), newChainUrl.trim());
    setL1Chains(httpService.getL1Chains());
    setNewChainName('');
    setNewChainUrl('');
  };

  const removeL1Chain = (index: number) => {
    httpService.removeL1Chain(index);
    setL1Chains(httpService.getL1Chains());
  };

  const saveL1Chain = (index: number, name: string, url: string) => {
    httpService.updateL1Chain(index, name, url);
    setL1Chains(httpService.getL1Chains());
  };

  const updateChainName = (index: number, name: string) => {
    const updated = l1Chains.map((c, i) => i === index ? { ...c, name } : c);
    setL1Chains(updated);
    saveL1Chain(index, name, updated[index].url);
  };

  const updateChainUrl = (index: number, url: string) => {
    const updated = l1Chains.map((c, i) => i === index ? { ...c, url } : c);
    setL1Chains(updated);
    saveL1Chain(index, updated[index].name, url);
  };

  const resetDefaults = () => {
    setUseTestnet(false);
    setServerUrl('https://p.bigtangle.org:8088/');
    httpService.setTestnet(false);
    httpService.setServerUrl('https://p.bigtangle.org:8088/');
    httpService.setL1Chains([
      { name: 'Main', url: 'https://m.bigtangle.org' },
      { name: 'Test', url: 'https://testm.bigtangle.org' },
    ]);
    setL1Chains(httpService.getL1Chains());
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
        <Text style={s.cardLabel}>L1 Chains</Text>
        <Text style={s.settingDesc}>Configure L1 order match chains</Text>

        {l1Chains.map((chain, i) => (
          <View key={i} style={s.chainRow}>
            <View style={s.chainFields}>
              <TextInput style={s.chainInput} value={chain.name}
                onChangeText={(v) => updateChainName(i, v)}
                placeholder="Name" placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" />
              <TextInput style={s.chainInput} value={chain.url}
                onChangeText={(v) => updateChainUrl(i, v)}
                placeholder="https://..." placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            </View>
            <TouchableOpacity style={s.removeBtn} onPress={() => removeL1Chain(i)}>
              <Text style={s.removeBtnText}>X</Text>
            </TouchableOpacity>
          </View>
        ))}

        <View style={s.addChainRow}>
          <TextInput style={s.chainInputSmall} value={newChainName}
            onChangeText={setNewChainName} placeholder="Name" placeholderTextColor={s.placeholder.color}
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
}));
