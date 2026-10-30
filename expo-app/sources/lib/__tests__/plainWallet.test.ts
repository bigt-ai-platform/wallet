import { describe, expect, it } from 'vitest';
import { serializePlainWallet } from '@/lib/plainWallet';

const key = {
  address: '16UmWyaGYmCWew2KGE1eUjiR1yMBdFSwKL',
  pubkey: '02abc',
  privateKey: 'ff00',
  keyType: 'EC',
  network: 'main',
};

describe('serializePlainWallet', () => {
  it('writes the plain SerializedWallet shape (keys[] without salt/data)', () => {
    const parsed = JSON.parse(serializePlainWallet(key));
    expect(parsed.keys).toEqual([key]);
    expect(parsed.salt).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  it('keeps credentials only when present (new wallets stay credential-free)', () => {
    expect(JSON.parse(serializePlainWallet(key)).credentials).toBeUndefined();
    const withCreds = JSON.parse(
      serializePlainWallet(key, { url: 'https://wallet.bigt.ai', user: 'u', password: 'p' }),
    );
    expect(withCreds.credentials).toEqual({
      url: 'https://wallet.bigt.ai',
      user: 'u',
      password: 'p',
    });
  });

  it('round-trips through JSON without losing the private key', () => {
    expect(JSON.parse(serializePlainWallet(key)).keys[0].privateKey).toBe('ff00');
  });
});
