import { describe, expect, it } from 'vitest';
import { toBigInt, localeSeparators, formatValue } from '../amountformat';

describe('amountformat', () => {
  it('toBigInt coerces and falls back to 0', () => {
    expect(toBigInt('123')).toBe(123n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt('not-a-number')).toBe(0n);
  });

  it('localeSeparators picks up the locale grouping', () => {
    expect(localeSeparators('en')).toEqual({ thousand: ',', decimal: '.' });
    expect(localeSeparators('de')).toEqual({ thousand: '.', decimal: ',' });
  });

  it('formatValue groups thousands like Java MonetaryFormat.FIAT', () => {
    expect(formatValue(1234567n, 0, 'en')).toBe('1,234,567');
    expect(formatValue(-1234567n, 0, 'en')).toBe('-1,234,567');
    // 8 decimals, trailing zeros trimmed
    expect(formatValue(123450000n, 8, 'en')).toBe('1.2345');
    expect(formatValue(0n, 8, 'en')).toBe('0');
  });

  it('formatValue uses the locale decimal separator', () => {
    expect(formatValue(123450000n, 8, 'de')).toBe('1,2345');
    expect(formatValue(123456700000n, 6, 'de')).toBe('123.456,7');
  });
});
