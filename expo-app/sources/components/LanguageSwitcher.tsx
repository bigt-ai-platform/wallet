import * as React from 'react';
import { View, Text, TouchableOpacity, Modal } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useTranslation } from 'react-i18next';
import { useUnistyles } from 'react-native-unistyles';
import { GlobeIcon, CloseIcon } from './Icons';
import { supportedLanguages } from '@/lib/i18n';

export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const { theme } = useUnistyles();
  const [visible, setVisible] = React.useState(false);

  const current = supportedLanguages.find(l => l.code === i18n.language) || supportedLanguages[0];

  const changeLang = (code: string) => {
    i18n.changeLanguage(code);
    setVisible(false);
  };

  return (
    <>
      <TouchableOpacity onPress={() => setVisible(true)} style={styles.trigger}
        accessibilityRole="button" accessibilityLabel={t('common.langAriaChange')} accessibilityHint={t('common.language')}>
        <GlobeIcon size={20} color={theme.colors.text.secondary} />
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setVisible(false)}>
          <View style={styles.dialog}>
            <View style={styles.header}>
              <Text style={styles.headerText}>{t('common.language')}</Text>
              <TouchableOpacity onPress={() => setVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                <CloseIcon size={18} color={theme.colors.text.secondary} />
              </TouchableOpacity>
            </View>
            {supportedLanguages.map((lang) => (
              <TouchableOpacity key={lang.code} onPress={() => changeLang(lang.code)}
                style={[styles.option, current.code === lang.code && styles.optionActive]}>
                <Text style={styles.flag}>{lang.flag}</Text>
                <Text style={[styles.optionText, current.code === lang.code && styles.optionTextActive]}>
                  {lang.name}
                </Text>
                {current.code === lang.code && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 6,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialog: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: theme.borderRadius.xl,
    width: 260,
    maxWidth: '90%',
    paddingVertical: theme.margins.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.margins.lg,
    paddingVertical: theme.margins.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerText: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text.primary,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.margins.sm,
    paddingHorizontal: theme.margins.lg,
  },
  optionActive: {
    backgroundColor: theme.colors.groupped.background,
  },
  flag: {
    fontSize: 20,
    marginRight: theme.margins.sm,
  },
  optionText: {
    fontSize: 15,
    fontWeight: '400',
    color: theme.colors.text.primary,
  },
  optionTextActive: {
    fontWeight: '600',
  },
  checkmark: {
    marginLeft: 'auto',
    color: theme.colors.primary,
    fontSize: 16,
  },
}));
