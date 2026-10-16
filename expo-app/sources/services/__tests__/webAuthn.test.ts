import { describe, expect, it, vi } from 'vitest';

// storage pulls in react-native-mmkv; stub it so the module loads in node.
vi.mock('@/storage', () => ({
  device: { get: () => undefined, set: () => {}, remove: () => {} },
}));

import { webAuthnSupported, platformAuthenticatorAvailable, confirmWithPlatformAuthenticator } from '../webAuthn';

describe('webAuthn outside a browser', () => {
  it('is unsupported (no window / PublicKeyCredential)', () => {
    expect(webAuthnSupported()).toBe(false);
  });

  it('reports unavailable so the caller falls back to the wallet password', async () => {
    expect(await platformAuthenticatorAvailable()).toBe(false);
    expect(await confirmWithPlatformAuthenticator()).toBe('unavailable');
  });
});
