import { describe, expect, it } from 'vitest';
import { RAIL_I18N_KEYS, railLabel } from '../p2pRails';

/** Identity "translator" that echoes the key, so the mapping is visible. */
const echo = (key: string) => key;

describe('p2pRails', () => {
  it('maps every known protocol rail to a translation key', () => {
    expect(RAIL_I18N_KEYS).toEqual({
      wechat: 'p2p.railWechat',
      alipay: 'p2p.railAlipay',
      bank: 'p2p.railBank',
      paypal: 'p2p.railPaypal',
    });
  });

  it('translates a rail through t instead of showing the raw id', () => {
    expect(railLabel(echo, 'wechat')).toBe('p2p.railWechat');
    expect(railLabel(echo, 'alipay')).toBe('p2p.railAlipay');
    expect(railLabel(echo, 'bank')).toBe('p2p.railBank');
    expect(railLabel(echo, 'paypal')).toBe('p2p.railPaypal');
  });

  it('returns the localized value from the dictionary', () => {
    const zh: Record<string, string> = {
      'p2p.railWechat': '微信',
      'p2p.railAlipay': '支付宝',
      'p2p.railBank': '银行卡',
      'p2p.railPaypal': 'PayPal',
    };
    expect(railLabel((k) => zh[k] ?? k, 'wechat')).toBe('微信');
    expect(railLabel((k) => zh[k] ?? k, 'alipay')).toBe('支付宝');
    expect(railLabel((k) => zh[k] ?? k, 'bank')).toBe('银行卡');
  });

  it('falls through unknown rails unchanged', () => {
    expect(railLabel(echo, 'wise')).toBe('wise');
  });
});
