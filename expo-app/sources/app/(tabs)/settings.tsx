/**
 * Settings Screen
 *
 * App configuration and settings
 */

import * as React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { device } from '@/storage';

export default function SettingsScreen() {
  

  const [serverUrl, setServerUrl] = React.useState('');
  const [useTestnet, setUseTestnet] = React.useState(false);
  const [hasChanges, setHasChanges] = React.useState(false);

  React.useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = () => {
    const url = httpService.getServerUrl();
    const testnet = device.get(['settings', 'useTestnet']) === 'true';
    setServerUrl(url);
    setUseTestnet(testnet);
  };

  const handleServerUrlChange = (text: string) => {
    setServerUrl(text);
    setHasChanges(true);
  };

  const handleTestnetToggle = (value: boolean) => {
    setUseTestnet(value);
    setHasChanges(true);
  };

  const handleSave = () => {
    try {
      if (serverUrl.trim()) {
        httpService.setServerUrl(serverUrl.trim());
      }
      httpService.setTestnet(useTestnet);
      setHasChanges(false);
      Alert.alert('Success', 'Settings saved successfully');
    } catch (error) {
      console.error('Error saving settings:', error);
      Alert.alert('Error', 'Failed to save settings');
    }
  };

  const handleReset = () => {
    Alert.alert(
      'Reset Settings',
      'Are you sure you want to reset to default settings?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            device.remove(['settings', 'serverUrl']);
            device.remove(['settings', 'useTestnet']);
            loadSettings();
            setHasChanges(false);
            Alert.alert('Success', 'Settings reset to defaults');
          },
        },
      ]
    );
  };

  return (
    <ScrollView style={stylesheet.container} contentContainerStyle={stylesheet.content}>
      <Text style={stylesheet.title}>Settings</Text>

      {/* Network Settings */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.sectionTitle}>Network</Text>

        <View style={stylesheet.settingRow}>
          <View style={stylesheet.settingLeft}>
            <Text style={stylesheet.settingLabel}>Use Testnet</Text>
            <Text style={stylesheet.settingDescription}>
              Connect to test network instead of mainnet
            </Text>
          </View>
          <Switch
            value={useTestnet}
            onValueChange={handleTestnetToggle}
            trackColor={{ false: '#767577', true: stylesheet.switchTrack.color }}
            thumbColor={useTestnet ? '#fff' : '#f4f3f4'}
          />
        </View>

        <View style={stylesheet.settingColumn}>
          <Text style={stylesheet.settingLabel}>Server URL</Text>
          <Text style={stylesheet.settingDescription}>
            Custom server endpoint (leave empty for default)
          </Text>
          <TextInput
            style={stylesheet.input}
            value={serverUrl}
            onChangeText={handleServerUrlChange}
            placeholder="https://p.bigtangle.org:8088/"
            placeholderTextColor={stylesheet.placeholder.color}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {/* About */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.sectionTitle}>About</Text>
        <View style={stylesheet.infoCard}>
          <Text style={stylesheet.infoLabel}>App Version</Text>
          <Text style={stylesheet.infoValue}>1.0.0</Text>
        </View>
        <View style={stylesheet.infoCard}>
          <Text style={stylesheet.infoLabel}>Platform</Text>
          <Text style={stylesheet.infoValue}>React Native (Expo)</Text>
        </View>
      </View>

      {/* Actions */}
      <View style={stylesheet.actions}>
        {hasChanges && (
          <TouchableOpacity style={[stylesheet.button, stylesheet.primaryButton]} onPress={handleSave}>
            <Text style={stylesheet.buttonText}>Save Changes</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={stylesheet.button} onPress={handleReset}>
          <Text style={[stylesheet.buttonText, stylesheet.resetButtonText]}>Reset to Defaults</Text>
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: theme.colors.text.primary,
    marginBottom: 24,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  settingColumn: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  settingLeft: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  switchTrack: {
    color: theme.colors.primary,
  },
  input: {
    backgroundColor: theme.colors.groupped.background,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: theme.colors.text.primary,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  placeholder: {
    color: theme.colors.text.secondary,
  },
  infoCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
  },
  infoLabel: {
    fontSize: 14,
    color: theme.colors.text.secondary,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.text.primary,
  },
  actions: {
    marginTop: 16,
  },
  button: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  resetButtonText: {
    color: theme.colors.text.primary,
  },
}));
