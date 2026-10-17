import { describe, it, expect } from 'vitest';
import { findBalance, amountToRaw, exceedsBalance, perUnitPrice, totalAmount } from '../p2pBalance';
import type { WalletAccountItem } from '@/types/api';

function bal(partial: Partial<WalletAccountItem>): WalletAccountItem {
  return {
    tokenid: 'bc',
    tokenname: 'BIG',
    balance: '0',
    confirmedBalance: '0',
    unconfirmedBalance: '0',
    decimals: 8,
    ...partial,
  };
}

const USDT = bal({ tokenid: 'aa', tokenname: 'USDT', balance: '100', raw: '10000000000', decimals: 8 });
const BIG = bal({ tokenid: 'bc', tokenname: 'BIG', balance: '1.5', raw: '150000000', decimals: 8 });

describe('findBalance', () => {
  it('matches by token id first', () => {
    expect(findBalance([USDT, BIG], { tokenId: 'aa' })?.tokenid).toBe('aa');
  });
  it('falls back to an unambiguous name match', () => {
    expect(findBalance([USDT, BIG], { tokenName: 'usdt' })?.tokenid).toBe('aa');
  });
  it('does not guess when a free-text name is ambiguous or unknown', () => {
    const dup = bal({ tokenid: 'x', tokenname: 'USDT' });
    expect(findBalance([USDT, dup], { tokenName: 'USDT' })).toBeNull();
    expect(findBalance([USDT], { tokenName: 'NOPE' })).toBeNull();
  });
});

describe('amountToRaw', () => {
  it('scales to the token decimals exactly', () => {
    expect(amountToRaw('1.5', 8)).toBe(150000000n);
    expect(amountToRaw('100', 8)).toBe(10000000000n);
    expect(amountToRaw('0.00000001', 8)).toBe(1n);
  });
  it('rejects non-decimal input', () => {
    expect(amountToRaw('', 8)).toBeNull();
    expect(amountToRaw('1,2', 8)).toBeNull();
    expect(amountToRaw('-1', 8)).toBeNull();
    expect(amountToRaw('abc', 8)).toBeNull();
  });
});

describe('exceedsBalance', () => {
  it('is advisory when the balance is unknown', () => {
    expect(exceedsBalance('999999', null)).toBe(false);
    expect(exceedsBalance('999999', bal({ raw: '', balance: '—' }))).toBe(false);
  });
  it('blocks only when the amount strictly exceeds a known balance', () => {
    expect(exceedsBalance('100.00000001', USDT)).toBe(true);
    expect(exceedsBalance('100', USDT)).toBe(false);
    expect(exceedsBalance('99', USDT)).toBe(false);
  });
  it('uses raw when present and balance decimals otherwise', () => {
    const noRaw = bal({ tokenid: 'z', tokenname: 'Z', balance: '2.5', decimals: 8 });
    delete (noRaw as { raw?: string }).raw;
    expect(exceedsBalance('2.5', noRaw)).toBe(false);
    expect(exceedsBalance('2.50000001', noRaw)).toBe(true);
  });
});

describe('perUnitPrice', () => {
  it('divides the total by the quantity, trimming zeros', () => {
    expect(perUnitPrice('715', '10')).toBe('71.5');
    expect(perUnitPrice('3', '4')).toBe('0.75');
    expect(perUnitPrice('0.01', '100')).toBe('0.0001');
  });
  it('is null when the inputs are unusable', () => {
    expect(perUnitPrice('0', '10')).toBeNull();
    expect(perUnitPrice('1', '0')).toBeNull();
    expect(perUnitPrice('abc', '10')).toBeNull();
    expect(perUnitPrice('1', 'x')).toBeNull();
  });
});

describe('totalAmount', () => {
  it('multiplies the unit price by the amount (Binance Total)', () => {
    expect(totalAmount('7.15', '100')).toBe('715');
    expect(totalAmount('0.01', '100')).toBe('1');
    expect(totalAmount('2.5', '4')).toBe('10');
  });
  it('is null when the inputs are unusable', () => {
    expect(totalAmount('', '100')).toBeNull();
    expect(totalAmount('1', '0')).toBeNull();
    expect(totalAmount('x', '1')).toBeNull();
  });
});
