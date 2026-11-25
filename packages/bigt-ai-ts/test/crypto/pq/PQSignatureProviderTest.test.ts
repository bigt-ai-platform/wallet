import { describe, it, expect, beforeAll } from 'vitest';
import {
  BcPQSignatureProvider,
  UnsupportedOperationException,
  PQConstants,
} from '../../../src/index';
import type { PQKeyPair } from '../../../src/index';

const LONG_TIMEOUT = 60_000;

describe('PQSignatureProvider', () => {
  let provider: BcPQSignatureProvider;
  let seed: Uint8Array;

  beforeAll(() => {
    provider = new BcPQSignatureProvider();
    seed = new Uint8Array(32).fill(0x5a);
  });

  it('generateMLDSAKeyPair', () => {
    const kp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, seed);

    expect(kp).toBeDefined();
    expect(kp.algorithm).toBe(PQConstants.ALG_ML_DSA_87);
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey.length).toBeGreaterThan(0);
    expect(kp.privateKey.length).toBeGreaterThan(0);
  });

  it('mldsaSignAndVerify', () => {
    const mlSeed = seed.slice(0, 32);
    const kp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, mlSeed);

    const message = new Uint8Array(64).fill(0x33);

    const signature = provider.sign(PQConstants.ALG_ML_DSA_87, kp.privateKey, message);

    expect(signature).toBeDefined();
    expect(signature.length).toBeGreaterThan(0);

    const valid = provider.verify(PQConstants.ALG_ML_DSA_87, kp.publicKey, message, signature);
    expect(valid).toBe(true);
  });

  it('mldsaBadSignatureRejected', () => {
    const mlSeed = seed.slice(0, 32);
    const kp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, mlSeed);

    const message = new Uint8Array(64).fill(0x34);

    const signature = provider.sign(PQConstants.ALG_ML_DSA_87, kp.privateKey, message);

    signature[10] ^= 0x01;

    const valid = provider.verify(PQConstants.ALG_ML_DSA_87, kp.publicKey, message, signature);
    expect(valid).toBe(false);
  });

  it('mldsaBadMessageRejected', () => {
    const mlSeed = seed.slice(0, 32);
    const kp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, mlSeed);

    const message = new Uint8Array(64).fill(0x35);

    const signature = provider.sign(PQConstants.ALG_ML_DSA_87, kp.privateKey, message);

    message[0] ^= 0x01;

    const valid = provider.verify(PQConstants.ALG_ML_DSA_87, kp.publicKey, message, signature);
    expect(valid).toBe(false);
  });

  it('mldsaBadPublicKeyRejected', () => {
    const mlSeed = seed.slice(0, 32);
    const kp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, mlSeed);

    const message = new Uint8Array(64).fill(0x36);

    const signature = provider.sign(PQConstants.ALG_ML_DSA_87, kp.privateKey, message);

    const otherSeed = new Uint8Array(32).fill(0x37);
    const otherKp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, otherSeed);

    const valid = provider.verify(PQConstants.ALG_ML_DSA_87, otherKp.publicKey, message, signature);
    expect(valid).toBe(false);
  });

  it('generateSLHDSAKeyPair', () => {
    const slhSeed = new Uint8Array(32).fill(0x38);
    const kp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSeed);

    expect(kp).toBeDefined();
    expect(kp.algorithm).toBe(PQConstants.ALG_SLH_DSA_SHA2_256S);
    expect(kp.publicKey).toBeDefined();
    expect(kp.privateKey).toBeDefined();
  }, LONG_TIMEOUT);

  it('slhdsaSignAndVerify', () => {
    const slhSeed = new Uint8Array(32).fill(0x39);
    const kp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSeed);

    const message = new Uint8Array(64).fill(0x3a);

    const signature = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, kp.privateKey, message);

    expect(signature).toBeDefined();
    expect(signature.length).toBeGreaterThan(0);

    const valid = provider.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, kp.publicKey, message, signature);
    expect(valid).toBe(true);
  }, LONG_TIMEOUT);

  it('slhdsaBadSignatureRejected', () => {
    const slhSeed = new Uint8Array(32).fill(0x3b);
    const kp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSeed);

    const message = new Uint8Array(64).fill(0x3c);

    const signature = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, kp.privateKey, message);

    signature[20] ^= 0x01;

    const valid = provider.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, kp.publicKey, message, signature);
    expect(valid).toBe(false);
  }, LONG_TIMEOUT);

  it('supportedAlgorithmsReported', () => {
    const algs = provider.supportedAlgorithms();
    expect(algs.length).toBeGreaterThanOrEqual(1);
    expect(algs).toContain(PQConstants.ALG_ML_DSA_87);
  });

  it('unknownAlgorithmThrows', () => {
    expect(() => provider.sign(99, new Uint8Array(32), new Uint8Array(1)))
      .toThrow(UnsupportedOperationException);
  });
});
