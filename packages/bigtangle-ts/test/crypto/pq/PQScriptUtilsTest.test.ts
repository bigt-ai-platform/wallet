import { describe, it, expect, beforeAll } from 'vitest';
import {
  BcPQSignatureProvider,
  PQScriptUtils,
  PQKeyDerivation,
  PQConstants,
  KeyBundle,
  KeyBundleEntry,
  SignatureBundle,
  SignatureBundleEntry,
  Sha256Hash,
} from '../../../src/index';

const LONG_TIMEOUT = 120_000;

describe('PQScriptUtils', () => {
  let provider: BcPQSignatureProvider;
  let mlKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let slhKp: { publicKey: Uint8Array; privateKey: Uint8Array };
  let keyBundle: KeyBundle;
  let prefixedPubkey: Uint8Array;

  beforeAll(() => {
    provider = new BcPQSignatureProvider();
    PQScriptUtils.setProvider(provider);

    const seed = new Uint8Array(64).fill(0x81);
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

  it('isPQPubkeyNullReturnsFalse', () => {
    expect(PQScriptUtils.isPQPubkey(null as unknown as Uint8Array)).toBe(false);
  });

  it('isPQPubkeyTooShortReturnsFalse', () => {
    expect(PQScriptUtils.isPQPubkey(new Uint8Array([PQScriptUtils.PQ_PUBKEY_PREFIX]))).toBe(false);
  });

  it('isPQPubkeyValidReturnsTrue', () => {
    expect(PQScriptUtils.isPQPubkey(prefixedPubkey)).toBe(true);
  });

  it('prefixedPubkeyRoundTrip', () => {
    const prefixed = PQScriptUtils.prefixedPubkey(keyBundle);
    expect(prefixed[0]).toBe(PQScriptUtils.PQ_PUBKEY_PREFIX);
    const extracted = PQScriptUtils.extractKeyBundle(prefixed);
    expect(Array.from(extracted.serialize())).toEqual(Array.from(keyBundle.serialize()));
  });

  it('verifyPQwithBothValidSignaturesReturnsTrue', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('test-domain-sep'));
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

  it('verifyPQwithBadSignatureReturnsFalse', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('bad-test'));
    const baseHash = Sha256Hash.twiceOf(msg);

    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const badMlSig = Uint8Array.from(mlSig);
    badMlSig[Math.floor(badMlSig.length / 2)] ^= 0xFF;

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, badMlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash)).toBe(false);
  }, LONG_TIMEOUT);

  it('verifyPQwithMissingEntryReturnsFalse', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('missing-entry'));
    const baseHash = Sha256Hash.twiceOf(msg);

    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
    ]);

    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash, true)).toBe(false);
    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash, false)).toBe(true);
  }, LONG_TIMEOUT);

  it('verifyProposerSignatureValidReturnsTrue', () => {
    const signingHash = Sha256Hash.hash(new TextEncoder().encode('block-header-hash'));

    const mlMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyProposerSignature(keyBundle, sb, signingHash)).toBe(true);
  }, LONG_TIMEOUT);

  it('verifyProposerSignatureBadReturnsFalse', () => {
    const signingHash = Sha256Hash.hash(new TextEncoder().encode('wrong-block'));
    const wrongHash = Sha256Hash.hash(new TextEncoder().encode('different'));

    const mlMsg = PQScriptUtils.domainSeparatedHash(wrongHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(wrongHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyProposerSignature(keyBundle, sb, signingHash)).toBe(false);
  }, LONG_TIMEOUT);

  it('domainSeparatedHashOverloadsConsistent', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('consistency'));
    const domainStr = 'TEST-DOMAIN';

    const fromSha = PQScriptUtils.domainSeparatedHash(Sha256Hash.wrap(msg), domainStr);
    const fromRaw = PQScriptUtils.domainSeparatedHash(msg, domainStr);

    expect(Array.from(fromSha)).toEqual(Array.from(fromRaw));
  });

  it('verifyPQwithWrongDomainSeparatorFails', () => {
    const msg = Sha256Hash.hash(new TextEncoder().encode('wrong-domain'));
    const baseHash = Sha256Hash.twiceOf(msg);

    const txHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);

    const mlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, mlMsg);
    const slhSig = provider.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.privateKey, slhMsg);

    const wrongTxHash = PQScriptUtils.domainSeparatedHash(baseHash.getBytes(), 'WRONG-DOMAIN-v1');
    const wrongMlMsg = PQScriptUtils.domainSeparatedHash(wrongTxHash, PQConstants.MLDSA_SIG_DOMAIN);

    const wrongMlSig = provider.sign(PQConstants.ALG_ML_DSA_87, mlKp.privateKey, wrongMlMsg);

    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, wrongMlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);

    expect(PQScriptUtils.verifyPQ(prefixedPubkey, sb.serialize(), baseHash)).toBe(false);
  }, LONG_TIMEOUT);
});
