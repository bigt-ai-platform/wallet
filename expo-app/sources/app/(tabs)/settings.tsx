import * as React from 'react';
import { View, Text, TextInput, Switch, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import {
  autoDiscoverEnabled,
  refresh as refreshDiscovery,
  setAutoDiscoverEnabled,
} from '@/services/discovery';
import { MONO_FONT } from '@/constants/fonts';
import { APP_VERSION } from '@/constants/app';
import ChainBadge from '@/components/ChainBadge';
import { checkForUpdate, confirmUpdate, currentVersion, installFailureText, installUpdate, isUpdaterAvailable } from '@/services/updater';
import type { L1ChainConfig } from '@/types/api';

/** OTA updates: show the installed version and offer a manual check + install
 *  against the release manifest (native Android only; a no-op on web). */
function UpdatesCard() {
  const { t } = useTranslation();
  const [ver, setVer] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    currentVersion().then((v) => setVer(v?.versionName ?? null)).catch(() => {});
  }, []);

  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const info = await checkForUpdate();
      if (!info) { setStatus(t('updates.unavailable')); return; }
      if (!info.hasUpdate) { setStatus(t('updates.upToDate')); return; }
      if (!info.mandatory && !(await confirmUpdate(info.versionName))) return;
      const res = await installUpdate(info);
      setStatus(res.ok ? t('updates.installing') : installFailureText(res));
    } catch {
      setStatus(t('updates.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.card} testID="settings-updates-card">
      <Text style={s.cardLabel}>{t('updates.title')}</Text>
      <View style={s.aboutRow}>
        <Text style={s.aboutLabel}>{t('updates.current')}</Text>
        <Text style={s.aboutValue}>{ver ? `v${ver}` : APP_VERSION}</Text>
      </View>
      <TouchableOpacity style={s.saveBtn} onPress={check} disabled={busy} testID="settings-check-update">
        <Text style={s.saveBtnText}>{busy ? t('updates.checking') : t('updates.check')}</Text>
      </TouchableOpacity>
      {!!status && <Text style={s.updateStatus} testID="settings-update-status">{status}</Text>}
    </View>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const [useTestnet, setUseTestnet] = React.useState(() => {
    const stored = (httpService as any).getServerUrl?.();
    return stored?.includes('test') ?? false;
  });
  const [serverUrl, setServerUrl] = React.useState(httpService.getServerUrl());
  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  const [activeChainId, setActiveChainId] = React.useState(() => httpService.getActiveL1ChainId());
  const [newChainId, setNewChainId] = React.useState('');
  const [newChainName, setNewChainName] = React.useState('');
  const [newChainUrl, setNewChainUrl] = React.useState('');

  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Chains(httpService.getL1Chains());
    setActiveChainId(httpService.getActiveL1ChainId());
  }), []);
  const appVersion = APP_VERSION;

  // Auto server selection (checkchains.sh-based, default ON): the endpoints the
  // request layer would use first right now.
  const [autoDiscover, setAutoDiscover] = React.useState(() => autoDiscoverEnabled());
  const [activeEndpoints, setActiveEndpoints] = React.useState({ l0: '', l1: '' });
  const updateActiveEndpoints = React.useCallback(() => {
    setActiveEndpoints({
      l0: httpService.l0Bases()[0] ?? '',
      l1: httpService.l1Bases()[0] ?? '',
    });
  }, []);
  React.useEffect(() => { updateActiveEndpoints(); }, [updateActiveEndpoints]);

  const toggleAutoDiscover = (val: boolean) => {
    setAutoDiscover(val);
    setAutoDiscoverEnabled(val);
    if (val) {
      // pick immediately instead of waiting for the next scheduler tick
      void refreshDiscovery('l0').catch(() => {}).finally(() => updateActiveEndpoints());
      void refreshDiscovery('l1').catch(() => {}).finally(() => updateActiveEndpoints());
    } else {
      updateActiveEndpoints();
    }
  };

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
        <View style={s.settingRow}>
          <View style={s.settingLeft}>
            <Text style={s.settingLabel}>{t('settings.autoDiscover')}</Text>
            <Text style={s.settingDesc}>{t('settings.autoDiscoverDesc')}</Text>
            {autoDiscover && !!activeEndpoints.l0 && (
              <Text style={s.settingDesc} testID="auto-discover-active">
                {t('settings.autoDiscoverUsing', { l0: activeEndpoints.l0, l1: activeEndpoints.l1 })}
              </Text>
            )}
          </View>
          <Switch value={autoDiscover} onValueChange={toggleAutoDiscover}
            trackColor={{ false: s.switchOff.color, true: s.switchOn.color }}
            thumbColor={autoDiscover ? s.switchThumb.color : '#f4f3f4'} testID="autodiscover-toggle" />
        </View>
      </View>

      {!autoDiscover && (
        <View style={s.card}>
          <Text style={s.cardLabel}>{t('settings.serverUrl')}</Text>
          <TextInput style={s.input} value={serverUrl} onChangeText={setServerUrl}
            placeholder="https://..." placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="server-url-input" />
          <TouchableOpacity style={s.saveBtn} onPress={saveServer}>
            <Text style={s.saveBtnText}>{t('settings.save')}</Text>
          </TouchableOpacity>
        </View>
      )}

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
              {!autoDiscover && (
                <TextInput style={s.chainInput} value={chain.url}
                  onChangeText={(v) => updateChainUrl(i, v)}
                  placeholder="https://..." placeholderTextColor={s.placeholder.color}
                  autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              )}
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
          {!autoDiscover && (
            <TextInput style={s.chainInputSmall} value={newChainUrl}
              onChangeText={setNewChainUrl} placeholder="https://..." placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          )}
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

      {isUpdaterAvailable() && <UpdatesCard />}

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
  updateStatus: { fontSize: 13, color: theme.colors.text.secondary, marginTop: 10, textAlign: 'center' },
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
}));
