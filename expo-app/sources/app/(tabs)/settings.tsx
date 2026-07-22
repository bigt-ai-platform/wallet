import * as React from 'react';
import { View, Text, TextInput, Switch, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const [useTestnet, setUseTestnet] = React.useState(() => {
    const stored = (httpService as any).getServerUrl?.();
    return stored?.includes('test') ?? false;
  });
  const [serverUrl, setServerUrl] = React.useState(httpService.getServerUrl());
  const appVersion = '1.2.0';

  const toggleTestnet = (val: boolean) => {
    setUseTestnet(val);
    httpService.setTestnet(val);
    if (val) setServerUrl('https://testp.bigtangle.org:8088/');
    else setServerUrl('https://p.bigtangle.org:8088/');
  };

  const saveServer = () => {
    if (!serverUrl.trim()) { Alert.alert('Error', t('settings.urlEmpty')); return; }
    httpService.setServerUrl(serverUrl.trim());
    Alert.alert(t('settings.saved'), t('settings.serverUpdated'));
  };

  const resetDefaults = () => {
    setUseTestnet(false);
    setServerUrl('https://p.bigtangle.org:8088/');
    httpService.setTestnet(false);
    httpService.setServerUrl('https://p.bigtangle.org:8088/');
    Alert.alert(t('settings.reset'), t('settings.resetDone'));
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

      <Text style={s.footer}>Bapp v{appVersion}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  card: {
    backgroundColor: theme.colors.card.background, borderRadius: 12,
    borderWidth: 1, borderColor: theme.colors.card.border, padding: 16, marginBottom: 12,
  },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  settingLeft: { flex: 1, marginRight: 12 },
  settingLabel: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  settingDesc: { fontSize: 12, color: theme.colors.text.secondary },
  switchOff: { color: theme.colors.border },
  switchOn: { color: theme.colors.primary },
  switchThumb: { color: '#FFFFFF' },
  input: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary,
    padding: 12, fontSize: 13, fontFamily: 'monospace',
  },
  placeholder: { color: theme.colors.text.secondary },
  saveBtn: {
    backgroundColor: theme.colors.primary, borderRadius: 8,
    paddingVertical: 10, alignItems: 'center', marginTop: 10,
  },
  saveBtnText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  aboutLabel: { fontSize: 14, color: theme.colors.text.secondary },
  aboutValue: { fontSize: 14, fontWeight: '600', color: theme.colors.text.primary },
  resetBtn: {
    borderRadius: 10, borderWidth: 1, borderColor: theme.colors.accent.red,
    paddingVertical: 13, alignItems: 'center', marginTop: 8,
  },
  resetBtnText: { fontSize: 14, fontWeight: '600', color: theme.colors.accent.red },
  footer: { fontSize: 12, color: theme.colors.text.secondary, textAlign: 'center', marginTop: 20 },
}));
