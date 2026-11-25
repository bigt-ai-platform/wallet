import { describe, it, expect } from 'vitest';
import {
  SignatureBundle,
  SignatureBundleEntry,
  PQConstants,
} from '../../../src/index';

function filled(size: number, value: number): Uint8Array {
  return new Uint8Array(size).fill(value);
}

function sameBundle(a: SignatureBundle, b: SignatureBundle): boolean {
  return Array.from(a.serialize()).join(',') === Array.from(b.serialize()).join(',');
}

describe('SignatureBundle', () => {
  it('serializeRoundTrip', () => {
    const sig1 = filled(4627, 0x03);
    const sig2 = filled(16123, 0x04);

    const bundle = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, sig1),
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, sig2),
    ]);

    const serialized = bundle.serialize();
    const deserialized = SignatureBundle.deserialize(serialized);

    expect(sameBundle(bundle, deserialized)).toBe(true);
    expect(deserialized.entries.length).toBe(2);
  });

  it('entriesSortedByAlgorithmId', () => {
    const sig1 = filled(100, 0x01);
    const sig2 = filled(200, 0x02);

    const bundle = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, sig1),
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, sig2),
    ]);

    expect(bundle.entries[0].algorithm).toBe(PQConstants.ALG_ML_DSA_87);
    expect(bundle.entries[1].algorithm).toBe(PQConstants.ALG_SLH_DSA_SHA2_256S);
  });

  it('versionFieldPreserved', () => {
    const bundle = new SignatureBundle(
      [new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, new Uint8Array(4627))],
      7,
    );

    expect(bundle.version).toBe(7);
    expect(bundle.serialize()[0] & 0xFF).toBe(7);
  });

  it('getEntryByAlgorithm', () => {
    const sig = filled(4627, 0x09);
    const bundle = new SignatureBundle([
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, sig),
    ]);

    expect(bundle.getEntry(PQConstants.ALG_ML_DSA_87)).not.toBeNull();
    expect(bundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S)).toBeUndefined();
  });
});
