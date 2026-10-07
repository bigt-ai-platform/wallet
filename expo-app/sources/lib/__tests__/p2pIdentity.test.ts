import { describe, it, expect } from 'vitest';
import { PQKey, Sha256Hash, Utils, SignatureBundle } from 'bigtangle-ts';
import { canonicalJson, pqDidFromKey, pqKeyFromPrivateHex, signP2pPayload, signedBody } from '../p2pIdentity';

/** Deterministic ML-DSA-87 test key. The wallet stores the serialized
 *  `getPrivateKeyHex()`, so round-trip through that same form. */
const STORED_HEX = PQKey.fromMLDSA(new Uint8Array(32).fill(0x11)).getPrivateKeyHex();

/** Mirrors services/p2p-engine `verifyChallengeWithPQDid` (canonical sha256 digest). */
function engineVerifies(payload: Record<string, unknown>, sigHex: string, prefixedPub: Uint8Array): boolean {
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonicalJson(payload)));
  const bundle = SignatureBundle.deserialize(Utils.HEX.decode(sigHex));
  return PQKey.verify(Sha256Hash.wrap(digest), bundle, prefixedPub);
}

describe('p2pIdentity', () => {
  it('derives a did:key over the PQ key', () => {
    const key = pqKeyFromPrivateHex(STORED_HEX);
    const did = pqDidFromKey(key);
    expect(did.startsWith('did:key:z')).toBe(true);
    expect(pqDidFromKey(pqKeyFromPrivateHex(STORED_HEX))).toBe(did);
  });

  it('signs the canonical payload so the engine verifier accepts it', () => {
    const key = pqKeyFromPrivateHex(STORED_HEX);
    const did = pqDidFromKey(key);
    const payload = { b: 2, a: 1, did };
    const sig = signP2pPayload(key, payload);
    expect(engineVerifies(payload, sig, key.getPrefixedPublicKeyBytes())).toBe(true);
    // any tampered field invalidates the signature
    expect(engineVerifies({ ...payload, a: 3 }, sig, key.getPrefixedPublicKeyBytes())).toBe(false);
  });

  it('canonicalJson sorts top-level keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('signedBody binds did, nonce and timestamp under the signature', () => {
    const key = pqKeyFromPrivateHex(STORED_HEX);
    const did = pqDidFromKey(key);
    const body = signedBody(key, did, { foo: 'bar' }, 1000) as Record<string, unknown>;
    expect(body.did).toBe(did);
    expect(body.timestamp).toBe(1000);
    expect((body.nonce as string).length).toBeGreaterThanOrEqual(16);
    const { signature, ...payload } = body;
    expect(engineVerifies(payload, signature as string, key.getPrefixedPublicKeyBytes())).toBe(true);
  });
});
