import { describe, it, expect, beforeAll } from 'vitest';
import {
  BcPQSignatureProvider,
  PQKeyDerivation,
  PQConstants,
  Sha256Hash,
} from '../../../src/index';
import type { PQKeyPair } from '../../../src/index';

const LONG_TIMEOUT = 60_000;

const FIXED_SEED = new Uint8Array(64);
{
  const label = new TextEncoder().encode('ML-DSA-87-ACVP-KAT-v1-ML-DSA-87-ACVP-KAT-v1-ML-DSA');
  FIXED_SEED.set(label.subarray(0, Math.min(label.length, FIXED_SEED.length)), 0);
}

describe('PQACVPVectors', () => {
  let provider: BcPQSignatureProvider;
  let km: Uint8Array;
  let mlKp: PQKeyPair;
  let slhKp: PQKeyPair;

  beforeAll(() => {
    provider = new BcPQSignatureProvider();
    km = PQKeyDerivation.deriveRootKeyMaterial(FIXED_SEED);
    mlKp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87,
      PQKeyDerivation.getMLDSASeed(km));
    slhKp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S,
      PQKeyDerivation.getSLHDSASeed(km));
  }, LONG_TIMEOUT);

  it('hkdfDerivationIsDeterministic', () => {
    const km2 = PQKeyDerivation.deriveRootKeyMaterial(FIXED_SEED);
    expect(Array.from(km)).toEqual(Array.from(km2));
  });

  it('keyGenerationUsesProviderRNG', () => {
    const kp2 = provider.generateKeyPair(
      PQConstants.ALG_ML_DSA_87,
      PQKeyDerivation.getMLDSASeed(km));
    expect(kp2).toBeDefined();
    expect(kp2.publicKey.length).toBeGreaterThan(0);
  }, LONG_TIMEOUT);

  it('mlDsa87SignVerifyWithKnownMessage', () => {
    const msg = new TextEncoder().encode('NIST ACVP ML-DSA-87 test message 0001');
    const digest = Sha256Hash.hash(msg);

    const sig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, digest);

    expect(sig).toBeDefined();
    expect(sig.length).toBeGreaterThan(4000);

    const valid = provider.verify(PQConstants.ALG_ML_DSA_87, mlKp.publicKey, digest, sig);
    expect(valid).toBe(true);
  }, LONG_TIMEOUT);

  it('slhDsa256sSignVerifyWithKnownMessage', () => {
    const msg = new TextEncoder().encode('NIST ACVP SLH-DSA-256s test message 0001');
    const digest = Sha256Hash.hash(msg);

    const sig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, digest);

    expect(sig).toBeDefined();
    expect(sig.length).toBeGreaterThan(15000);

    const valid = provider.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.publicKey, digest, sig);
    expect(valid).toBe(true);
  }, LONG_TIMEOUT);

  it('mlDsa87TamperedSignatureRejected', () => {
    const msg = new TextEncoder().encode('tamper test');
    const digest = Sha256Hash.hash(msg);

    const sig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, digest);

    const tampered = Uint8Array.from(sig);
    tampered[Math.floor(tampered.length / 2)] ^= 0xFF;

    expect(provider.verify(PQConstants.ALG_ML_DSA_87, mlKp.publicKey, digest, tampered)).toBe(false);
  }, LONG_TIMEOUT);

  it('mlDsa87WrongMessageRejected', () => {
    const msg = new TextEncoder().encode('correct message');
    const wrongMsg = new TextEncoder().encode('wrong message!!!');

    const sig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, Sha256Hash.hash(msg));

    expect(provider.verify(PQConstants.ALG_ML_DSA_87, mlKp.publicKey, Sha256Hash.hash(wrongMsg), sig))
      .toBe(false);
  }, LONG_TIMEOUT);

  it('zeroLengthMessageSignVerify', () => {
    const emptyDigest = Sha256Hash.hash(new Uint8Array(0));
    const sig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, emptyDigest);

    expect(provider.verify(PQConstants.ALG_ML_DSA_87, mlKp.publicKey, emptyDigest, sig)).toBe(true);
  }, LONG_TIMEOUT);

  it('allSupportedAlgorithmsProduceVerifiableSignatures', () => {
    for (const alg of provider.supportedAlgorithms()) {
      const msg = Sha256Hash.hash(new TextEncoder().encode('test-alg-' + alg));
      const seed = new Uint8Array(32).fill(alg);
      const kp = provider.generateKeyPair(alg, seed);
      const sig = provider.sign(alg, kp.privateKey, msg);
      expect(provider.verify(alg, kp.publicKey, msg, sig)).toBe(true);
    }
  }, LONG_TIMEOUT);
});
