import { describe, expect, it } from 'vitest';
import { rlpEncode } from '../rlp';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('RLP encoder', () => {
  // Vectors from the Ethereum wiki / yellow paper examples.
  it('encodes single bytes and short strings', () => {
    expect(hex(rlpEncode('dog'))).toBe('83646f67');
    expect(hex(rlpEncode('a'))).toBe('61');
    expect(hex(rlpEncode(''))).toBe('80');
  });

  it('encodes small integers as minimal big-endian bytes', () => {
    expect(hex(rlpEncode(0))).toBe('80');
    expect(hex(rlpEncode(15))).toBe('0f');
    expect(hex(rlpEncode(1024))).toBe('820400');
    expect(hex(rlpEncode(BigInt(0)))).toBe('80');
    expect(hex(rlpEncode(127n))).toBe('7f');
    expect(hex(rlpEncode(128n))).toBe('8180');
  });

  it('encodes lists', () => {
    expect(hex(rlpEncode(['cat', 'dog']))).toBe('c88363617483646f67');
    expect(hex(rlpEncode([]))).toBe('c0');
    expect(hex(rlpEncode(['a']))).toBe('c161');
    expect(hex(rlpEncode([1, 2, 3]))).toBe('c3010203');
  });

  it('uses the long form for payloads of 56 bytes or more', () => {
    const out = hex(rlpEncode('z'.repeat(56)));
    expect(out.startsWith('b838')).toBe(true);
    expect(out.length).toBe(2 + 2 + 56 * 2);
  });

  it('rejects negative and unsafe integers', () => {
    expect(() => rlpEncode(-1)).toThrow();
    expect(() => rlpEncode(BigInt(-5))).toThrow();
    expect(() => rlpEncode(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });
});
