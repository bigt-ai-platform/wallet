import { describe, it, expect } from 'vitest';
import { PQKey, Sha256Hash, Utils, SignatureBundle } from 'bigtangle-ts';
import { verifyRecordSig, type AnchoredRecord } from 'record-sig';
import { P2P_ORDER_ID_RE } from 'p2p-protocol';
import {
  canonicalJson, canonicalRecordJson, newOrderId, pqDidFromKey, pqKeyFromPrivateHex,
  shortDid, signP2pPayload, signP2pRecord, signedBody,
} from '../p2pIdentity';

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

  it('author-signs a social record so record-sig verifyRecordSig accepts it', () => {
    const key = pqKeyFromPrivateHex(STORED_HEX);
    const record = {
      type: 'social.p2p-order',
      from: pqDidFromKey(key),
      to: 'ord-0123456789abcdef',
      ts: Date.now(),
      status: 'OPEN',
      orderSeq: 0,
      giveToken: 'USDT',
      giveAmount: '100',
      giveChain: 'L0',
      wantCurrency: 'USD',
      wantAmount: '101',
      wantRail: 'wechat',
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    };
    const signed = { ...record, ...signP2pRecord(key, record) };
    expect(verifyRecordSig(signed as unknown as AnchoredRecord)).toBe(true);
    // any tampered field invalidates it (canonicalization strips sig only)
    expect(verifyRecordSig({ ...signed, giveAmount: '99' } as unknown as AnchoredRecord)).toBe(false);
    // deep canonical form: nested keys sorted, sig/sigScheme stripped
    expect(canonicalRecordJson(signed as unknown as Record<string, unknown>)).toBe(
      canonicalRecordJson(record as unknown as Record<string, unknown>),
    );
  });

  it('mints order ids the engine accepts', () => {
    expect(P2P_ORDER_ID_RE.test(newOrderId())).toBe(true);
  });

  it('shortens a long did:key to head…tail', () => {
    const did = 'did:key:z' + 'A'.repeat(2500);
    const s = shortDid(did);
    expect(s.startsWith('did:key:z')).toBe(true);
    expect(s).toContain('…');
    expect(s.length).toBe(22 + 1 + 6);
    expect(s.endsWith('A'.repeat(6))).toBe(true);
    // The real seller did from the live order renders compactly.
    const live = 'did:key:z446Gmp1fqLFYjzfQGxTAiD2wQcZy5tMMQGXW9BN8rXVYwdB1NJV5Hsm3C3uCF6a8UbpSPgHv9ynLJGdLXF6qmysJe2SCS3gkqSRnbPDGh76MTg9Bd6hiA4YsUAXVL9PhVBk8j6';
    const s2 = shortDid(live);
    expect(s2).toMatch(/^did:key:z.{13}….{6}$/);
    expect(live.startsWith(s2.split('…')[0])).toBe(true);
    expect(live.endsWith(s2.split('…')[1])).toBe(true);
  });

  it('leaves short values and empties untouched', () => {
    expect(shortDid('did:key:zSHORT')).toBe('did:key:zSHORT');
    expect(shortDid('')).toBe('');
  });
});
