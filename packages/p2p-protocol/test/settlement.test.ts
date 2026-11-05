import { describe, it, expect } from 'vitest';
import { verifySettlement } from '../src/settlement.js';

describe('verifySettlement token aliases', () => {
  // A native BIG output: the escrow lock rows carry the token id (`bc`), the
  // order/swap usually carries the symbol (`BIG`). The two must agree.
  const big = {
    address: '3Escrow',
    token: 'bc',
    tokenId: 'bc',
    symbol: 'BIG',
    name: 'BIG',
    amount: '1000000000',
    confirmed: true,
    spent: false,
  };

  it('matches an order symbol/name against an id-shaped output', () => {
    expect(verifySettlement([big], { toAddress: '3Escrow', token: 'BIG', amount: '1000000000' }).ok).toBe(true);
    expect(verifySettlement([big], { toAddress: '3Escrow', token: 'bc', amount: '1000000000' }).ok).toBe(true);
    expect(verifySettlement([big], { toAddress: '3Escrow', token: 'big', amount: '1000000000' }).ok).toBe(true);
  });

  it('still rejects a different token or address', () => {
    expect(verifySettlement([big], { toAddress: '3Escrow', token: 'USDT', amount: '1' }).ok).toBe(false);
    expect(verifySettlement([big], { toAddress: '3Other', token: 'BIG', amount: '1' }).ok).toBe(false);
  });
});
