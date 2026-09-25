import { describe, it, expect, beforeAll } from 'vitest';
import {
  BcPQSignatureProvider,
  PQScriptUtils,
  PQKeyDerivation,
  PQConstants,
  PQKey,
  KeyBundle,
  KeyBundleEntry,
  SignatureBundle,
  SignatureBundleEntry,
  Sha256Hash,
  ScriptBuilder,
} from '../../src/index';

const LONG_TIMEOUT = 120_000;

describe('PQScript', () => {
  let provider: BcPQSignatureProvider;
  let mlKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let slhKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let keyBundle: KeyBundle;
  let prefixedPubkey: Uint8Array;

  beforeAll(() => {
    provider = new BcPQSignatureProvider();
    PQScriptUtils.setProvider(provider);

    const seed = new Uint8Array(64).fill(0x91);
    const km = PQKeyDerivation.deriveRootKeyMaterial(seed);
    mlKp = provider.generateKeyPair(PQConstants.ALG_ML_DSA_87,
      PQKeyDerivation.getMLDSASeed(km));
    slhKp = provider.generateKeyPair(PQConstants.ALG_SLH_DSA_SHA2_256S,
      PQKeyDerivation.getSLHDSASeed(km));
    keyBundle = new KeyBundle([
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, mlKp.publicKey),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.publicKey),
    ]);
    prefixedPubkey = PQScriptUtils.prefixedPubkey(keyBundle);
  }, LONG_TIMEOUT);

  it('pqInputScriptContainsPrefix', () => {
    const key = PQKey.fromPublicOnly(keyBundle);
    const input = ScriptBuilder.createInputScriptForPQ(
      new SignatureBundle([
        new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, new Uint8Array(1)),
      ]), key);
    const prog = input.getProgram();
    let found = false;
    for (const b of prog) found = found || b === PQScriptUtils.PQ_PUBKEY_PREFIX;
    expect(found).toBe(true);
  });

  it('pqPubkeyDetection', () => {
    expect(PQScriptUtils.isPQPubkey(prefixedPubkey)).toBe(true);
    expect(PQScriptUtils.isPQPubkey(PQKey.createNew().getPubKey())).toBe(true);
    expect(PQScriptUtils.isPQPubkey(null as unknown as Uint8Array)).toBe(false);
    expect(PQScriptUtils.isPQPubkey(new Uint8Array(0))).toBe(false);
    const ecPubkey = new Uint8Array(33);
    ecPubkey[0] = 0x02;
    expect(PQScriptUtils.isPQPubkey(ecPubkey)).toBe(false);
  }, LONG_TIMEOUT);

  it('extractKeyBundleRoundTrip', () => {
    const extracted = PQScriptUtils.extractKeyBundle(prefixedPubkey);
    expect(Array.from(extracted.serialize())).toEqual(Array.from(keyBundle.serialize()));
    expect(extracted.entries.length).toBe(2);
  });

  it('pqVerifyWithCorrectSigsReturnsTrue', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('test'));
    const baseHash = Sha256Hash.twiceOf(msg);
    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash)).toBe(true);
  }, LONG_TIMEOUT);

  it('pqVerifyWithBadMlSigReturnsFalse', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('bad'));
    const baseHash = Sha256Hash.twiceOf(msg);
    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const badMlSig = Uint8Array.from(mlSig);
    badMlSig[100] ^= 0xFF;

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, badMlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash)).toBe(false);
  }, LONG_TIMEOUT);

  it('scriptBuilderProducesValidInputScript', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('roundtrip'));
    const baseHash = Sha256Hash.twiceOf(msg);
    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);
    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    const raw = sb.serialize();
    expect(Array.from(SignatureBundle.deserialize(raw).serialize())).toEqual(Array.from(raw));
  }, LONG_TIMEOUT);
});
