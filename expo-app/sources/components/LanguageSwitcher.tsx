import * as React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useUnistyles } from 'react-native-unistyles';
import { GlobeIcon, CloseIcon } from './Icons';
import { supportedLanguages } from '@/lib/i18n';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const { theme } = useUnistyles();
  const [visible, setVisible] = React.useState(false);

  const current = supportedLanguages.find(l => l.code === i18n.language) || supportedLanguages[0];

  const changeLang = (code: string) => {
    i18n.changeLanguage(code);
    setVisible(false);
  };

  return (
    <>
      <TouchableOpacity onPress={() => setVisible(true)} style={{ padding: 6 }}>
        <GlobeIcon size={20} color={theme.colors.text.secondary} />
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}
          activeOpacity={1} onPress={() => setVisible(false)}>
          <View style={{
            backgroundColor: theme.colors.groupped.surface, borderRadius: 14,
            width: 260, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.border,
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.colors.text.primary }}>Language</Text>
              <TouchableOpacity onPress={() => setVisible(false)}>
                <CloseIcon size={18} color={theme.colors.text.secondary} />
              </TouchableOpacity>
            </View>
            {supportedLanguages.map((lang) => (
              <TouchableOpacity key={lang.code} onPress={() => changeLang(lang.code)}
                style={{
                  flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16,
                  backgroundColor: current.code === lang.code ? theme.colors.groupped.background : 'transparent',
                }}>
                <Text style={{ fontSize: 20, marginRight: 10 }}>{lang.flag}</Text>
                <Text style={{ fontSize: 15, fontWeight: current.code === lang.code ? '600' : '400', color: theme.colors.text.primary }}>{lang.name}</Text>
                {current.code === lang.code && (
                  <Text style={{ marginLeft: 'auto', color: theme.colors.primary, fontSize: 16 }}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}
