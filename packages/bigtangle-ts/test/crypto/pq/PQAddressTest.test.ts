import { describe, it, expect } from 'vitest';
import {
  PQAddress,
  PQConstants,
  KeyBundle,
  KeyBundleEntry,
} from '../../../src/index';

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('PQAddress', () => {
  it('addressFromKeyBundleIsDeterministic', () => {
    const pk1 = new Uint8Array(2560);
    const pk2 = new Uint8Array(64);
    for (let i = 0; i < 2560; i++) pk1[i] = i & 0xFF;
    for (let i = 0; i < 64; i++) pk2[i] = (i + 100) & 0xFF;

    const bundle1 = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const bundle2 = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const addr1 = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, bundle1);
    const addr2 = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, bundle2);

    expect(arraysEqual(addr1.serialize(), addr2.serialize())).toBe(true);
    expect(arraysEqual(addr1.hash, addr2.hash)).toBe(true);
  });

  it('addressMatchesKeyBundle', () => {
    const pk1 = new Uint8Array(2560);
    const pk2 = new Uint8Array(64);
    for (let i = 0; i < 2560; i++) pk1[i] = i & 0xFF;
    for (let i = 0; i < 64; i++) pk2[i] = (i + 200) & 0xFF;

    const bundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const addr = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, bundle);

    expect(addr.matches(bundle)).toBe(true);
  });

  it('addressRejectsWrongKeyBundle', () => {
    const pk1 = new Uint8Array(2560);
    const pk2 = new Uint8Array(64);
    const pk3 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pk2[i] = i & 0xFF;
    for (let i = 0; i < 64; i++) pk3[i] = (i + 99) & 0xFF;

    const bundle1 = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const bundle2 = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk3),
    ]);

    const addr = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, bundle1);

    expect(addr.matches(bundle2)).toBe(false);
  });

  it('serializeRoundTrip', () => {
    const pk1 = new Uint8Array(2560);
    const pk2 = new Uint8Array(64);
    const bundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const addr = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, bundle);

    const serialized = addr.serialize();
    expect(serialized.length).toBe(35);

    const deserialized = PQAddress.deserialize(serialized);
    expect(arraysEqual(deserialized.serialize(), addr.serialize())).toBe(true);
    expect(deserialized.version).toBe(addr.version);
    expect(deserialized.network).toBe(addr.network);
    expect(deserialized.suite).toBe(addr.suite);
  });

  it('hexRoundTrip', () => {
    const pk1 = new Uint8Array(2560);
    const pk2 = new Uint8Array(64);
    const bundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk1),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, pk2),
    ]);

    const addr = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_MAINNET, PQConstants.SUITE_CAT5_DUAL_1, bundle);

    const hex = addr.toHex();
    const fromHex = PQAddress.fromHex(hex);
    expect(arraysEqual(fromHex.serialize(), addr.serialize())).toBe(true);
  });

  it('networkAndSuitePreserved', () => {
    const pk = new Uint8Array(2560);
    const bundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pk),
    ]);

    const addr = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_MAINNET, PQConstants.SUITE_CAT5_DUAL_1, bundle);

    expect(addr.network).toBe(PQConstants.NETWORK_MAINNET);
    expect(addr.suite).toBe(PQConstants.SUITE_CAT5_DUAL_1);
    expect(addr.version).toBe(PQConstants.ADDRESS_VERSION);
  });
});
