import { describe, it, expect } from 'vitest';
import {
  BcPQSignatureProvider,
  PQScriptUtils,
  PQConstants,
  PQKey,
  KeyBundle,
  SignatureBundle,
  SignatureBundleEntry,
  Sha256Hash,
  Block,
  BlockType,
  TestParams,
  Utils,
} from '../../../src/index';

const LONG_TIMEOUT = 120_000;

const FILL_ML = new Uint8Array(32).fill(0x01);
const FILL_SLH = new Uint8Array(32).fill(0x02);

const SIGNING_HASH = Sha256Hash.hash(new TextEncoder().encode('proposer-header'));

function provider(): BcPQSignatureProvider {
  return new BcPQSignatureProvider();
}

function dualKey(): PQKey {
  return PQKey.fromSeeds(FILL_ML, FILL_SLH);
}

function mlOnlyKey(): PQKey {
  return PQKey.fromMLDSA(FILL_ML);
}

function proposerBlock(
  params: TestParams, height: number, key: PQKey, includeSlh: boolean
): Block {
  const b = Block.setBlock7(params, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH,
    BlockType.BLOCKTYPE_TRANSFER, 0, 0, 0);
  b.setHeight(height);
  b.setProposerKeyBundle(key.getKeyBundleBytes());
  const signingHash = b.computeProposerSigningHash();
  const p = provider();
  const entries: SignatureBundleEntry[] = [];
  const mlMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.MLDSA_SIG_DOMAIN);
  entries.push(new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87,
    p.sign(PQConstants.ALG_ML_DSA_87, key.getMLDSAPrivateKey(), mlMsg)));
  if (includeSlh) {
    const slhMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.SLHDSA_SIG_DOMAIN);
    entries.push(new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S,
      p.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, key.getSLHDSAPrivateKey(), slhMsg)));
  }
  b.setProposerSignatureBundle(new SignatureBundle(entries).serialize());
  return b;
}

describe('SuiteActivation', () => {
  it('genesisParamsAreMLDSAOnlyByDefault', () => {
    const params = new TestParams();
    expect(params.isPqSuiteActive(PQConstants.SUITE_ML_DSA_ONLY, 0)).toBe(true);
    expect(params.isPqSuiteActive(PQConstants.SUITE_ML_DSA_ONLY, -1)).toBe(false);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1, 0)).toBe(false);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(params.getPqSuiteActivationHeight(PQConstants.SUITE_CAT5_DUAL_1)).toBe(-1);
  });

  it('suiteActivationBoundaryIsInclusive', () => {
    const params = new TestParams();
    params.setPqSuiteActivationHeight(PQConstants.SUITE_CAT5_DUAL_1, 100_000);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1, 99_999)).toBe(false);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1, 100_000)).toBe(true);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1, 100_001)).toBe(true);
    expect(params.getPqSuiteActivationHeight(PQConstants.SUITE_CAT5_DUAL_1)).toBe(100_000);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1)).toBe(true);
    params.removePqSuite(PQConstants.SUITE_CAT5_DUAL_1);
    expect(params.isPqSuiteActive(PQConstants.SUITE_CAT5_DUAL_1)).toBe(false);
  });

  it('genesisPubMatchesMLDSAOnlySeed', () => {
    const expected = PQKey.fromMLDSA(FILL_ML);
    const genesisPub = Utils.HEX.decode(new TestParams().getGenesisPub());
    expect(PQScriptUtils.isPQPubkey(genesisPub)).toBe(true);
    const bundle = PQScriptUtils.extractKeyBundle(genesisPub);
    expect(bundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)).toBeUndefined();
    expect(bundle.getEntry(PQConstants.ALG_ML_DSA_87)).toBeDefined();
    expect(Array.from(bundle.getEntry(PQConstants.ALG_ML_DSA_87)!.publicKey))
      .toEqual(Array.from(expected.getKeyBundle().getEntry(PQConstants.ALG_ML_DSA_87)!.publicKey));
  }, LONG_TIMEOUT);

  it('mldsaOnlyProposerAcceptedBeforeActivation', () => {
    const key = mlOnlyKey();
    const p = provider();
    const mlMsg = PQScriptUtils.domainSeparatedHash(SIGNING_HASH, PQConstants.MLDSA_SIG_DOMAIN);
    const mlSig = p.sign(PQConstants.ALG_ML_DSA_87, key.getMLDSAPrivateKey(), mlMsg);
    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
    ]);

    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), sb, SIGNING_HASH, false))
      .toBe(true);
    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), sb, SIGNING_HASH, true))
      .toBe(false);
  }, LONG_TIMEOUT);

  it('dualKeyProposerMaySignMLDSAOnlyBeforeActivation', () => {
    const key = dualKey();
    const p = provider();
    const mlMsg = PQScriptUtils.domainSeparatedHash(SIGNING_HASH, PQConstants.MLDSA_SIG_DOMAIN);
    const mlSig = p.sign(PQConstants.ALG_ML_DSA_87, key.getMLDSAPrivateKey(), mlMsg);
    const sb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
    ]);

    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), sb, SIGNING_HASH, false))
      .toBe(true);
    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), sb, SIGNING_HASH, true))
      .toBe(false);
  }, LONG_TIMEOUT);

  it('dualKeyProposerRequiresSlhAfterActivation', () => {
    const key = dualKey();
    const p = provider();
    const mlMsg = PQScriptUtils.domainSeparatedHash(SIGNING_HASH, PQConstants.MLDSA_SIG_DOMAIN);
    const slhMsg = PQScriptUtils.domainSeparatedHash(SIGNING_HASH, PQConstants.SLHDSA_SIG_DOMAIN);
    const mlSig = p.sign(PQConstants.ALG_ML_DSA_87, key.getMLDSAPrivateKey(), mlMsg);
    const slhSig = p.sign(PQConstants.ALG_SLH_DSA_SHA2_256S, key.getSLHDSAPrivateKey(), slhMsg);
    const dualSb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig),
    ]);
    const mlOnlySb = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
    ]);

    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), dualSb, SIGNING_HASH, true))
      .toBe(true);
    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), dualSb, SIGNING_HASH, false))
      .toBe(true);
    expect(PQScriptUtils.verifyProposerSignature(key.getKeyBundle(), mlOnlySb, SIGNING_HASH, true))
      .toBe(false);
  }, LONG_TIMEOUT);

  it('pqKeySignSelectorControlsSlhDsa', () => {
    const dual = dualKey();
    const input = Sha256Hash.wrap(SIGNING_HASH);

    const mlOnly = dual.sign(input, false);
    expect(mlOnly.getEntry(PQConstants.ALG_ML_DSA_87)).toBeDefined();
    expect(mlOnly.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)).toBeUndefined();

    const both = dual.sign(input, true);
    expect(both.getEntry(PQConstants.ALG_ML_DSA_87)).toBeDefined();
    expect(both.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)).toBeDefined();

    expect(mlOnlyKey().sign(input, true).getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S))
      .toBeUndefined();
  }, LONG_TIMEOUT);

  it('blockVerifiesProposerByHeight', () => {
    const params = new TestParams();
    params.setPqSuiteActivationHeight(PQConstants.SUITE_CAT5_DUAL_1, 1000);

    const dual = dualKey();

    const below = proposerBlock(params, 999, dual, false);
    expect(below.verifyProposer()).toBe(true);

    const at = proposerBlock(params, 1000, dual, false);
    expect(at.verifyProposer()).toBe(false);

    const after = proposerBlock(params, 1000, dual, true);
    expect(after.verifyProposer()).toBe(true);

    const afterDown = proposerBlock(params, 1001, mlOnlyKey(), false);
    expect(afterDown.verifyProposer()).toBe(false);
  }, LONG_TIMEOUT);
});
