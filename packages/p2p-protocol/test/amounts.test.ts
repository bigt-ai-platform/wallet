import { describe, it, expect } from 'vitest';
import {
  P2P_BIG_FEE,
  escrowDepositAmount,
  escrowDepositFee,
  isBigToken,
} from '../src/amounts.js';

describe('escrow deposit (seller pays the BIG spend fee)', () => {
  it('adds the BIG fee so the buyer receives the advertised amount', () => {
    // 100 BIG advertised → 100.001 BIG locked; the spend pays 100 BIG.
    expect(escrowDepositAmount('100', 'BIG')).toBe('100.001');
    // The token id spelling must behave the same.
    expect(escrowDepositAmount('100', 'bc')).toBe('100.001');
    expect(escrowDepositAmount('0.5', 'big')).toBe('0.501');
  });

  it('leaves non-BIG escrows untouched (they pay out in full)', () => {
    expect(escrowDepositAmount('100', 'USDT')).toBe('100');
    expect(escrowDepositAmount('100', undefined)).toBe('100');
    expect(escrowDepositFee('USDT')).toBe('0');
  });

  it('exposes the fee itself and never crashes on a partially typed amount', () => {
    expect(escrowDepositFee('BIG')).toBe(P2P_BIG_FEE);
    expect(escrowDepositAmount('', 'BIG')).toBe('');
    expect(escrowDepositAmount('1.', 'BIG')).toBe('1.');
  });

  it('recognizes both BIG spellings only', () => {
    expect(isBigToken('BIG')).toBe(true);
    expect(isBigToken(' bc ')).toBe(true);
    expect(isBigToken('USDT')).toBe(false);
    expect(isBigToken(undefined)).toBe(false);
  });
});
