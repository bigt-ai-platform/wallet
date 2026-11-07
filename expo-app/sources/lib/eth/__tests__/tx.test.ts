import { describe, expect, it } from 'vitest';
import * as secp256k1 from 'secp256k1';
import {
  decodeType2,
  encodeUnsignedType2,
  recoverType2Signer,
  signEip1559,
  unsignedType2Hash,
  type Eip1559TxParams,
} from '../tx';
import { addressFromPrivateKey } from '../address';

const PRIV = Uint8Array.from(
  Buffer.from('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'hex')
);
const TO = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

function tx(over: Partial<Eip1559TxParams> = {}): Eip1559TxParams {
  return {
    chainId: 1n,
    nonce: 7n,
    maxPriorityFeePerGas: 1_500_000_000n,
    maxFeePerGas: 30_000_000_000n,
    gasLimit: 21_000n,
    to: TO,
    value: 1_000_000_000_000_000_000n,
    ...over,
  };
}

describe('EIP-1559 signing', () => {
  it('produces a type-2 raw transaction with a 32-byte hash', () => {
    const signed = signEip1559(tx(), PRIV);
    expect(signed.raw.startsWith('0x02')).toBe(true);
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.from).toBe(addressFromPrivateKey(Buffer.from(PRIV).toString('hex')));
  });

  it('recovers the signer from the signed payload (independent check)', () => {
    for (const params of [
      tx(),
      tx({ chainId: 11155111n }),
      tx({ data: '0xa9059cbb', value: 0n }),
    ]) {
      const signed = signEip1559(params, PRIV);
      expect(recoverType2Signer(signed.raw)).toBe(signed.from);
    }
  });

  it('is deterministic (RFC 6979) and chain-id bound', () => {
    const a = signEip1559(tx(), PRIV);
    const b = signEip1559(tx(), PRIV);
    expect(a.raw).toBe(b.raw);
    const other = signEip1559(tx({ chainId: 11155111n }), PRIV);
    expect(other.raw).not.toBe(a.raw);
    expect(other.hash).not.toBe(a.hash);
  });

  it('always emits a low-S signature (EIP-2)', () => {
    const { s } = decodeType2(signEip1559(tx(), PRIV).raw);
    const halfOrder = BigInt(
      '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'
    );
    expect(s).toBeGreaterThan(0n);
    expect(s).toBeLessThanOrEqual(halfOrder);
  });

  it('hashes exactly the unsigned payload', () => {
    const params = tx();
    const signed = signEip1559(params, PRIV);
    const digest = unsignedType2Hash(params);
    expect(digest).toHaveLength(32);
    expect(encodeUnsignedType2(params)[0]).toBe(0x02);
    // The signature must verify against the digest with the signer's pubkey.
    const pub = secp256k1.publicKeyCreate(PRIV, false);
    const { r, s } = decodeType2(signed.raw);
    const sig = new Uint8Array(64);
    sig.set(Uint8Array.from(Buffer.from(r.toString(16).padStart(64, '0'), 'hex')), 0);
    sig.set(Uint8Array.from(Buffer.from(s.toString(16).padStart(64, '0'), 'hex')), 32);
    expect(secp256k1.ecdsaVerify(sig, digest, pub)).toBe(true);
  });

  it('rejects an invalid recipient', () => {
    expect(() => signEip1559(tx({ to: '0x1234' }), PRIV)).toThrow();
  });
});
