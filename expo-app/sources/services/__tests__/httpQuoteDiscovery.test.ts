import { describe, expect, it, vi } from 'vitest';
import { findExchangeToken } from '@/lib/exchangeToken';

const usdt = { tokenid: 'wrapped-usdt', tokenname: 'USDT', decimals: 6 };

describe('quote token discovery', () => {
  it('uses the first provider that has the quote', async () => {
    const cny = { tokenid: 'l1-cny', tokenname: 'CNY', decimals: 0 };
    const l0 = vi.fn().mockResolvedValue({ success: true, data: [usdt] });
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [cny] });

    await expect(findExchangeToken('USDT', [l0, l1])).resolves.toEqual(usdt);
    expect(l1).not.toHaveBeenCalled();
  });

  it('falls back to the native L1 quote when L0 has no such token', async () => {
    const cny = { tokenid: 'l1-cny', tokenname: 'CNY', decimals: 0 };
    const l0 = vi.fn().mockResolvedValue({ success: true, data: [] });
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [cny] });

    await expect(findExchangeToken('CNY', [l0, l1])).resolves.toEqual(cny);
    expect(l0).toHaveBeenCalledWith('CNY');
    expect(l1).toHaveBeenCalledWith('CNY');
  });

  it('returns undefined when neither chain indexes the symbol', async () => {
    const l0 = vi.fn().mockResolvedValue({ success: true, data: [] });
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [] });

    await expect(findExchangeToken('NOPE', [l0, l1])).resolves.toBeUndefined();
  });
});
