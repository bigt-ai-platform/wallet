import { Platform } from 'react-native';

/**
 * Shared monospace font. Menlo on iOS, the system mono elsewhere (Android/web).
 */
export const MONO_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });
