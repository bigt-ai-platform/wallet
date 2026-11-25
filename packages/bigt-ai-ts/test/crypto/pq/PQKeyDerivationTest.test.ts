import { describe, it, expect } from 'vitest';
import {
  PQKeyDerivation,
  PQConstants,
} from '../../../src/index';

describe('PQKeyDerivation', () => {
  it('hkdfExtractExpandRoundTrip', () => {
    const ikm = new TextEncoder().encode('this is a test BIP39 seed material 123456');
    const salt = new TextEncoder().encode(PQConstants.HKDF_SALT);

    const prk = PQKeyDerivation.hkdfExtract(salt, ikm);
    expect(prk).not.toBeNull();
    expect(prk.length).toBe(32);

    const okm = PQKeyDerivation.hkdfExpand(prk, new TextEncoder().encode('test'), 64);
    expect(okm).not.toBeNull();
    expect(okm.length).toBe(64);
  });

  it('deterministicKeyDerivation', () => {
    const seed = new Uint8Array(64);
    for (let i = 0; i < 64; i++) seed[i] = (i * 7 + 1) & 0xFF;

    const km1 = PQKeyDerivation.deriveRootKeyMaterial(seed);
    const km2 = PQKeyDerivation.deriveRootKeyMaterial(seed);

    expect(Array.from(km1)).toEqual(Array.from(km2));
  });

  it('differentSeedsProduceDifferentKeys', () => {
    const seed1 = new Uint8Array(64).fill(0x11);
    const seed2 = new Uint8Array(64).fill(0x22);

    const km1 = PQKeyDerivation.deriveRootKeyMaterial(seed1);
    const km2 = PQKeyDerivation.deriveRootKeyMaterial(seed2);

    expect(Array.from(km1)).not.toEqual(Array.from(km2));
  });

  it('deriveChildKeys', () => {
    const seed = new Uint8Array(64);
    for (let i = 0; i < 64; i++) seed[i] = (i + 1) & 0xFF;

    const prk = PQKeyDerivation.hkdfExtract(
      new TextEncoder().encode(PQConstants.HKDF_SALT), seed);

    const child1 = PQKeyDerivation.deriveChildKey(prk, 0, PQConstants.SUITE_CAT5_DUAL_1);
    const child2 = PQKeyDerivation.deriveChildKey(prk, 0, PQConstants.SUITE_CAT5_DUAL_1);
    const child3 = PQKeyDerivation.deriveChildKey(prk, 1, PQConstants.SUITE_CAT5_DUAL_1);

    expect(child1.length).toBe(64);
    expect(Array.from(child1)).toEqual(Array.from(child2)); // same index -> same key
    expect(Array.from(child1)).not.toEqual(Array.from(child3)); // different index -> different key
  });

  it('rejectShortSeed', () => {
    const shortSeed = new Uint8Array(16);
    expect(() => PQKeyDerivation.deriveRootKeyMaterial(shortSeed)).toThrow();
  });
});
