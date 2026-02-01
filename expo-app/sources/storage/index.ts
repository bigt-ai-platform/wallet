/**
 * Simple storage abstraction using MMKV
 */

import { MMKV } from 'react-native-mmkv';

const storage = new MMKV();

export const device = {
  get(key: string[]): string | undefined {
    const storageKey = key.join('.');
    return storage.getString(storageKey);
  },
  set(key: string[], value: string): void {
    const storageKey = key.join('.');
    storage.set(storageKey, value);
  },
  remove(key: string[]): void {
    const storageKey = key.join('.');
    storage.delete(storageKey);
  },
};
