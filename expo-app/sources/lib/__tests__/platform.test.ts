import { describe, it, expect } from 'vitest';
import { isCapacitorNative } from '../platform';

describe('isCapacitorNative', () => {
  it('is false without a Capacitor global', () => {
    expect(isCapacitorNative(null)).toBe(false);
    expect(isCapacitorNative({})).toBe(false);
  });

  it('is false when the bridge reports web', () => {
    expect(isCapacitorNative({ isNativePlatform: () => false })).toBe(false);
  });

  it('is true when the bridge reports a native platform', () => {
    expect(isCapacitorNative({ isNativePlatform: () => true })).toBe(true);
  });

  it('falls back to globalThis.Capacitor when not passed', () => {
    const g = globalThis as { Capacitor?: { isNativePlatform?: () => boolean } };
    const prev = g.Capacitor;
    g.Capacitor = { isNativePlatform: () => true };
    try {
      expect(isCapacitorNative()).toBe(true);
    } finally {
      g.Capacitor = prev;
    }
  });
});
