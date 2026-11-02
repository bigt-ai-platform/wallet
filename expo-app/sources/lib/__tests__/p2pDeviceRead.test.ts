import { describe, it, expect } from 'vitest';
import { DEVICE_VERIFY_AFTER_MS, deviceReadMode, deviceReadSupported, deviceVerifyDue } from '../p2pDeviceRead';

describe('deviceReadMode', () => {
  it('reads the WeChat payee notification, never a WeChat buyer', () => {
    expect(deviceReadMode('wechat', 'seller')).toBe('notification');
    expect(deviceReadMode('wechat', 'buyer')).toBeNull();
  });

  it('reads the screen for Alipay and bank, on either side', () => {
    for (const rail of ['alipay', 'bank']) {
      expect(deviceReadMode(rail, 'seller')).toBe('screen');
      expect(deviceReadMode(rail, 'buyer')).toBe('screen');
    }
  });

  it('has no device bridge for PayPal on either side', () => {
    expect(deviceReadMode('paypal', 'seller')).toBeNull();
    expect(deviceReadMode('paypal', 'buyer')).toBeNull();
    expect(deviceReadSupported('paypal')).toBe(false);
  });

  describe('deviceVerifyDue', () => {
    const now = 1_700_000_000_000;
    const late = { wantRail: 'alipay', status: 'PAYMENT_CLAIMED', paidAt: now - DEVICE_VERIFY_AFTER_MS };

    it('is never offered to the seller', () => {
      expect(deviceVerifyDue(late, 'seller', now)).toBe(false);
    });

    it('is not offered before the seller is late', () => {
      expect(deviceVerifyDue({ ...late, paidAt: now - 60_000 }, 'buyer', now)).toBe(false);
    });

    it('is offered to a buyer once the release is overdue', () => {
      expect(deviceVerifyDue(late, 'buyer', now)).toBe(true);
      expect(deviceVerifyDue({ ...late, status: 'PAYMENT_VERIFIED' }, 'buyer', now)).toBe(true);
    });

    it('is offered immediately while a dispute is open', () => {
      const disputed = { wantRail: 'bank', status: 'PAYMENT_CLAIMED', paidAt: now, dispute: 'OPEN' };
      expect(deviceVerifyDue(disputed, 'buyer', now)).toBe(true);
    });

    it('is not offered on WeChat (payee-side read only) or PayPal', () => {
      expect(deviceVerifyDue({ ...late, wantRail: 'wechat' }, 'buyer', now)).toBe(false);
      expect(deviceVerifyDue({ ...late, wantRail: 'paypal' }, 'buyer', now)).toBe(false);
    });

    it('is not offered before the buyer claims payment', () => {
      expect(deviceVerifyDue({ ...late, status: 'PAYMENT_PENDING' }, 'buyer', now)).toBe(false);
    });
  });
});
