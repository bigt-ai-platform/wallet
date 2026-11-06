import { describe, expect, it } from 'vitest';
import { TX_FEE_RAW, txFeeAmount, txFeeRaw } from '../txFee';

describe('txFeeRaw', () => {
  it('charges the fee on L0 only (L1 order chains are fee-free)', () => {
    expect(txFeeRaw(0)).toBe(TX_FEE_RAW);
    expect(txFeeRaw(0)).toBe(1000n);
    expect(txFeeRaw(1)).toBe(0n);
    expect(txFeeRaw(2)).toBe(0n);
  });
});

describe('txFeeAmount', () => {
  it('is always denominated in BIG (6 decimals): 1000 raw = 0.001 BIG', () => {
    expect(txFeeAmount(0)).toBe('0.001');
    expect(txFeeAmount(1)).toBe('0');
  });
});
