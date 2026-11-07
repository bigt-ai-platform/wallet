import { describe, expect, it } from 'vitest';
import { formatUnits, isValidUnits, parseUnits, shortAddress } from '../units';

describe('Ethereum amount units', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseUnits('1', 18)).toBe(10n ** 18n);
    expect(parseUnits('0.5', 18)).toBe(5n * 10n ** 17n);
    expect(parseUnits('1.000000000000000001', 18)).toBe(10n ** 18n + 1n);
    expect(parseUnits('12.345678', 6)).toBe(12_345_678n);
    expect(parseUnits('0', 18)).toBe(0n);
    expect(() => parseUnits('', 18)).toThrow();
    expect(parseUnits('.5', 6)).toBe(500_000n);
  });

  it('rejects malformed amounts and too many decimals', () => {
    expect(() => parseUnits('abc', 18)).toThrow();
    expect(() => parseUnits('1.2.3', 18)).toThrow();
    expect(() => parseUnits('-1', 18)).toThrow();
    expect(() => parseUnits('0.0000001', 6)).toThrow();
    expect(isValidUnits('1.5', 6)).toBe(true);
    expect(isValidUnits('1.1234567', 6)).toBe(false);
  });

  it('formats raw units back', () => {
    expect(formatUnits(10n ** 18n, 18)).toBe('1');
    expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatUnits(1_234_567n, 6)).toBe('1.234567');
    expect(formatUnits(0n, 18)).toBe('0');
  });

  it('shortens addresses for lists', () => {
    expect(shortAddress('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')).toBe('0x7E5F…5Bdf');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});
