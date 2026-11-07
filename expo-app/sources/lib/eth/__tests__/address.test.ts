import { describe, expect, it } from 'vitest';
import {
  addressBytesFromPublicKey,
  addressFromPrivateKey,
  isAddress,
  isValidChecksumAddress,
  publicKeyUncompressed,
  requireAddress,
  sameAddress,
  toChecksumAddress,
} from '../address';

const PRIV_1 = `0x${'0'.repeat(63)}1`;
const PRIV_2 = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('Ethereum address derivation', () => {
  // Well-known vectors (private key 1, and a common test key).
  it('derives the address for private key 1', () => {
    expect(addressFromPrivateKey(PRIV_1)).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });

  it('derives the address for a second known key', () => {
    expect(addressFromPrivateKey(PRIV_2)).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  });

  it('accepts 64-byte and 33-byte public keys', () => {
    const uncompressed = publicKeyUncompressed(
      Uint8Array.from(Buffer.from(PRIV_2.slice(2), 'hex'))
    );
    const raw64 = uncompressed.subarray(1);
    expect(addressBytesFromPublicKey(raw64)).toEqual(addressBytesFromPublicKey(uncompressed));
  });

  it('rejects invalid private keys', () => {
    expect(() => addressFromPrivateKey(`0x${'00'.repeat(32)}`)).toThrow();
    expect(() => addressFromPrivateKey('0x1234')).toThrow();
  });
});

describe('EIP-55 checksums', () => {
  // Vectors from EIP-55.
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('produces the EIP-55 form', () => {
    for (const v of vectors) expect(toChecksumAddress(v.toLowerCase())).toBe(v);
  });

  it('accepts valid checksums and rejects poisoned mixed case', () => {
    for (const v of vectors) expect(isValidChecksumAddress(v)).toBe(true);
    // Flip the case of one letter in the valid checksum -> still a valid
    // address, but no longer EIP-55 (the poisoned/mistyped case).
    const valid = vectors[0];
    const letterAt = [...valid].findIndex((ch, i) => i >= 2 && /[a-fA-F]/.test(ch));
    const flipped = valid
      .split('')
      .map((ch, i) => {
        if (i !== letterAt) return ch;
        return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      })
      .join('');
    expect(flipped).not.toBe(valid);
    expect(isAddress(flipped)).toBe(true);
    expect(isValidChecksumAddress(flipped)).toBe(false);
    expect(() => requireAddress(flipped)).toThrow();
  });

  it('accepts all-lowercase input and normalizes it', () => {
    expect(isValidChecksumAddress(vectors[0].toLowerCase())).toBe(true);
    expect(requireAddress(vectors[0].toLowerCase())).toBe(vectors[0]);
  });

  it('compares addresses case-insensitively', () => {
    expect(sameAddress(vectors[0], vectors[0].toLowerCase())).toBe(true);
    expect(sameAddress(vectors[0], vectors[1])).toBe(false);
  });
});
