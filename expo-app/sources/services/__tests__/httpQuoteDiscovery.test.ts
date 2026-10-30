import { describe, expect, it, vi } from 'vitest';
import { findExchangeToken } from '@/lib/exchangeToken';

const usdt = { tokenid: 'wrapped-usdt', tokenname: 'USDT', decimals: 6 };

describe('quote token discovery', () => {
  it('falls back to the L0 index for bridge-wrapped quotes', async () => {
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [] });
    const l0 = vi.fn().mockResolvedValue({ success: true, data: [usdt] });

    await expect(findExchangeToken('USDT', [l1, l0])).resolves.toEqual(usdt);
    expect(l1).toHaveBeenCalledWith('USDT');
    expect(l0).toHaveBeenCalledWith('USDT');
  });

  it('prefers an L1 token when the chain indexes the quote itself', async () => {
    const cny = { tokenid: 'l1-cny', tokenname: 'CNY', decimals: 0 };
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [cny] });
    const l0 = vi.fn();

    await expect(findExchangeToken('CNY', [l1, l0])).resolves.toEqual(cny);
    expect(l0).not.toHaveBeenCalled();
  });

  it('returns undefined when neither chain indexes the symbol', async () => {
    const l1 = vi.fn().mockResolvedValue({ success: true, data: [] });
    const l0 = vi.fn().mockResolvedValue({ success: true, data: [] });

    await expect(findExchangeToken('NOPE', [l1, l0])).resolves.toBeUndefined();
  });
});
