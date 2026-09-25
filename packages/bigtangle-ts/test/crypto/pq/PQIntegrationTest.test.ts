import { describe, it, expect } from 'vitest';
import {
  BcPQSignatureProvider,
  PQKeyDerivation,
  PQConstants,
  PQAddress,
  KeyBundle,
  KeyBundleEntry,
  SignatureBundle,
  SignatureBundleEntry,
  Sha256Hash,
} from '../../../src/index';

const LONG_TIMEOUT = 120_000;

function domainSeparatedHash(txDigest: Uint8Array, domain: string): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const combined = new Uint8Array(domainBytes.length + txDigest.length);
  combined.set(domainBytes, 0);
  combined.set(txDigest, domainBytes.length);
  return Sha256Hash.hash(combined);
}

describe('PQIntegration', () => {
  const provider = new BcPQSignatureProvider();

  it('fullDualSignatureWorkflow', () => {
    const seed = new Uint8Array(64).fill(0x71);
    const keyMaterial = PQKeyDerivation.deriveRootKeyMaterial(seed);

    const mlDsaSeed = PQKeyDerivation.getMLDSASeed(keyMaterial);
    const slhDsaSeed = PQKeyDerivation.getSLHDSASeed(keyMaterial);

    const mlKp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87, mlDsaSeed);
    const slhKp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S, slhDsaSeed);

    const keyBundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, mlKp.publicKey),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.publicKey),
    ]);

    const address = PQAddress.fromKeyBundle(
      PQConstants.NETWORK_TESTNET, PQConstants.SUITE_CAT5_DUAL_1, keyBundle);

    const message = new TextEncoder().encode('hello post-quantum world');
    const txDigest = Sha256Hash.twiceOf(message).getBytes();

    const mlSighash = domainSeparatedHash(txDigest, PQConstants.MLDSA_SIG_DOMAIN);
    const slhSighash = domainSeparatedHash(txDigest, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlSighash);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhSighash);

    const sigBundle = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(address.matches(keyBundle)).toBe(true);

    const mlValid = provider.verify(PQConstants.ALG_ML_DSA_87,
      keyBundle.getEntry(PQConstants.ALG_ML_DSA_87)!.publicKey,
      mlSighash,
      sigBundle.getEntry(PQConstants.ALG_ML_DSA_87)!.signature);
    expect(mlValid).toBe(true);

    const slhValid = provider.verify(PQConstants.ALG_SLH_DSA_SHA2_256S,
      keyBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)!.publicKey,
      slhSighash,
      sigBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)!.signature);
    expect(slhValid).toBe(true);
  }, LONG_TIMEOUT);

  it('oneBadSignatureFailsButOtherSurvives', () => {
    const seed = new Uint8Array(64).fill(0x72);
    const keyMaterial = PQKeyDerivation.deriveRootKeyMaterial(seed);

    const mlKp = provider.generateKeyPair(
      PQConstants.ALG_ML_DSA_87, PQKeyDerivation.getMLDSASeed(keyMaterial));
    const slhKp = provider.generateKeyPair(
      PQConstants.ALG_SLH_DSA_SHA2_256S, PQKeyDerivation.getSLHDSASeed(keyMaterial));

    const txDigest = Sha256Hash.twiceOf(new TextEncoder().encode('test')).getBytes();

    const mlSighash = domainSeparatedHash(txDigest, PQConstants.MLDSA_SIG_DOMAIN);
    const slhSighash = domainSeparatedHash(txDigest, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlSighash);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhSighash);

    const badMlSig = Uint8Array.from(mlSig);
    badMlSig[42] ^= 0xFF;

    const mlBad = provider.verify(PQConstants.ALG_ML_DSA_87, mlKp.publicKey, mlSighash, badMlSig);
    expect(mlBad).toBe(false);

    const slhGood = provider.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.publicKey, slhSighash, slhSig);
    expect(slhGood).toBe(true);
  }, LONG_TIMEOUT);
});
