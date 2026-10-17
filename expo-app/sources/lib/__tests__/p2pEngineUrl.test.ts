import { describe, it, expect } from 'vitest';
import { p2pEngineUrl } from '../p2pEngineUrl';

const PROD = 'https://wallet.bigt.ai/p2p';

describe('p2pEngineUrl', () => {
  it('uses the public engine on a native (Android/Capacitor) build', () => {
    // The Capacitor app is a wrap of the static export: isDev and isWebBrowser
    // are both false, and there is no same-origin /p2p proxy.
    expect(p2pEngineUrl({ env: undefined, isDev: false, isWebBrowser: false, prodUrl: PROD })).toBe(PROD);
  });

  it('stays empty in a plain browser production build (not-configured state)', () => {
    expect(p2pEngineUrl({ env: undefined, isDev: false, isWebBrowser: true, prodUrl: PROD })).toBe('');
  });

  it('defaults to the local engine in dev', () => {
    expect(p2pEngineUrl({ env: undefined, isDev: true, isWebBrowser: false, prodUrl: PROD })).toBe('http://127.0.0.1:8108');
  });

  it('honours a baked EXPO_PUBLIC_P2P_ENGINE_URL over every default', () => {
    expect(p2pEngineUrl({ env: '/p2p', isDev: false, isWebBrowser: true, prodUrl: PROD })).toBe('/p2p');
    expect(p2pEngineUrl({ env: 'http://127.0.0.1:8108', isDev: false, isWebBrowser: false, prodUrl: PROD })).toBe('http://127.0.0.1:8108');
  });
});
