import { describe, it, expect } from 'vitest';
import { PQKey, PQConstants, Utils, Sha256Hash } from '../../../src/index';

const LONG_TIMEOUT = 60000;

describe('PQKey', () => {
  it('creates a new key', () => {
    const key = PQKey.createNew();
    expect(key).toBeDefined();
    expect(key.hasPrivateKey()).toBe(true);
    expect(key.toAddressHex().length).toBe(70);
  }, LONG_TIMEOUT);

  it('creates key from seeds deterministically', () => {
    const mlSeed = new Uint8Array(32).fill(0x42);
    const slSeed = new Uint8Array(32).fill(0x99);
    const key1 = PQKey.fromSeeds(mlSeed, slSeed);
    const key2 = PQKey.fromSeeds(mlSeed, slSeed);
    expect(key1.toAddressHex()).toBe(key2.toAddressHex());
    expect(key1.getPrivateKeyHex()).toBe(key2.getPrivateKeyHex());
  }, LONG_TIMEOUT);

  it('different seeds produce different keys', () => {
    const a = PQKey.fromSeeds(new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0x02));
    const b = PQKey.fromSeeds(new Uint8Array(32).fill(0x03), new Uint8Array(32).fill(0x04));
    expect(a.toAddressHex()).not.toBe(b.toAddressHex());
  }, LONG_TIMEOUT);

  it('signs and verifies a message', () => {
    const key = PQKey.createNew();
    const msg = new Sha256Hash(new Uint8Array(32).fill(0xAB));
    const sig = key.sign(msg);
    expect(sig).toBeDefined();
    expect(sig.entries.length).toBe(2);

    const ok = PQKey.verify(msg, sig, key.getPublicKeyBytes());
    expect(ok).toBe(true);
  }, LONG_TIMEOUT);

  it('rejects modified signature', () => {
    const key = PQKey.createNew();
    const msg = new Sha256Hash(new Uint8Array(32).fill(0xAB));
    const sig = key.sign(msg);
    sig.entries[0] = { algorithm: sig.entries[0].algorithm, signature: new Uint8Array(sig.entries[0].signature.length).fill(0x00) };
    const ok = PQKey.verify(msg, sig, key.getPublicKeyBytes());
    expect(ok).toBe(false);
  }, LONG_TIMEOUT);

  it('roundtrips private key serialization', () => {
    const key = PQKey.createNew();
    const privHex = key.getPrivateKeyHex();
    const restored = PQKey.fromPrivateKey(Utils.HEX.decode(privHex));
    expect(restored.toAddressHex()).toBe(key.toAddressHex());
    expect(restored.hasPrivateKey()).toBe(true);

    const msg = new Sha256Hash(new Uint8Array(32).fill(0xCD));
    const sig = restored.sign(msg);
    const ok = PQKey.verify(msg, sig, key.getPublicKeyBytes());
    expect(ok).toBe(true);
  }, LONG_TIMEOUT);

  it('fromPublicOnly creates a verification-only key', () => {
    const key = PQKey.createNew();
    const pubOnly = PQKey.fromPublicOnly(key.getPublicKeyBytes());
    expect(pubOnly.hasPrivateKey()).toBe(false);
    expect(pubOnly.toAddressHex()).toBe(key.toAddressHex());

    const msg = new Sha256Hash(new Uint8Array(32).fill(0xEF));
    const sig = key.sign(msg);
    const ok = PQKey.verify(msg, sig, pubOnly.getPublicKeyBytes());
    expect(ok).toBe(true);
  }, LONG_TIMEOUT);

  it('fromKeyMaterial derives deterministic key', () => {
    const material = new Uint8Array(64).fill(0x77);
    const key = PQKey.fromKeyMaterial(material);
    expect(key.hasPrivateKey()).toBe(true);
    expect(key.toAddressHex().length).toBe(70);
  }, LONG_TIMEOUT);

  it('produces correct PQAddress format', () => {
    const key = PQKey.createNew(PQConstants.NETWORK_MAINNET);
    const addr = key.toAddress();
    expect(addr.version).toBe(1);
    expect(addr.network).toBe(0);
    expect(addr.hash.length).toBe(32);
    expect(addr.serialize().length).toBe(35);
  }, LONG_TIMEOUT);
});
