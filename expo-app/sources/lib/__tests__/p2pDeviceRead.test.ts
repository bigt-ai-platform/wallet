import { describe, it, expect } from 'vitest';
import { deviceReadMode } from '../p2pDeviceRead';

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
});
