import { Alert, Platform } from 'react-native';

/**
 * Show a message dialog across platforms. react-native-web's Alert.alert is a
 * no-op, so on web the native window.alert is used instead — otherwise errors
 * and confirmations would be silently swallowed (e.g. a failed payment would
 * look like "nothing happened").
 */
export function showAlert(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message ? `${title}\n${message}` : title);
    }
    return;
  }
  Alert.alert(title, message);
}
