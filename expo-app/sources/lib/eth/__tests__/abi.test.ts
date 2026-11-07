import { describe, expect, it } from 'vitest';
import {
  ERC20_SELECTORS,
  decodeString,
  decodeUint,
  encodeBalanceOf,
  encodeTransfer,
  uintWord,
} from '../abi';

const TO = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

describe('ERC-20 ABI codec', () => {
  it('uses the canonical selectors', () => {
    expect(ERC20_SELECTORS.balanceOf).toBe('0x70a08231');
    expect(ERC20_SELECTORS.transfer).toBe('0xa9059cbb');
    expect(ERC20_SELECTORS.decimals).toBe('0x313ce567');
    expect(ERC20_SELECTORS.symbol).toBe('0x95d89b41');
  });

  it('encodes balanceOf(address)', () => {
    const data = encodeBalanceOf(TO);
    expect(data).toBe(
      '0x70a082310000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf'
    );
  });

  it('encodes transfer(address,uint256)', () => {
    const data = encodeTransfer(TO, 1_000_000n);
    expect(data.startsWith('0xa9059cbb')).toBe(true);
    expect(data.length).toBe(2 + 8 + 64 + 64);
    expect(data.endsWith(`${'0'.repeat(58)}0f4240`)).toBe(true);
  });

  it('encodes uint256 words', () => {
    expect(Buffer.from(uintWord(1n)).toString('hex')).toBe(`${'0'.repeat(63)}1`);
    expect(Buffer.from(uintWord(2n ** 256n - 1n)).toString('hex')).toBe('ff'.repeat(32));
    expect(() => uintWord(2n ** 256n)).toThrow();
    expect(() => uintWord(-1n)).toThrow();
  });

  it('decodes uint and string returns', () => {
    const one = `0x${'0'.repeat(63)}1`;
    expect(decodeUint(one)).toBe(1n);
    expect(decodeUint('0x')).toBe(0n);
    // ABI string "USDT": offset 32, length 4, bytes
    const str =
      '0x' +
      '0'.repeat(62) +
      '20' +
      '0'.repeat(63) +
      '4' +
      Buffer.from('USDT').toString('hex').padEnd(64, '0');
    expect(decodeString(str)).toBe('USDT');
    expect(decodeString('0x')).toBe('');
  });
});
