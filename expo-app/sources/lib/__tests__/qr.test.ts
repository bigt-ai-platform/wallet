import { describe, expect, it } from 'vitest';
import {
  isAddressLike,
  isWebUrl,
  parseQrContent,
  paymentRequestFromJson,
} from '../qr';

describe('isWebUrl', () => {
  it('recognizes http(s) links', () => {
    expect(isWebUrl('https://wallet.bigt.ai/pay')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
    expect(isWebUrl('www.bigtangle.org')).toBe(true);
  });
  it('rejects non-links', () => {
    expect(isWebUrl('bigtangle address')).toBe(false);
    expect(isWebUrl('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs')).toBe(false);
  });
});

describe('isAddressLike', () => {
  it('matches base58 EC addresses', () => {
    expect(isAddressLike('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs')).toBe(true);
    expect(isAddressLike('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
  });
  it('matches hex PQ addresses', () => {
    expect(isAddressLike('a'.repeat(70))).toBe(true);
  });
  it('rejects non-addresses', () => {
    expect(isAddressLike('hello world')).toBe(false);
    expect(isAddressLike('https://example.com')).toBe(false);
    expect(isAddressLike('')).toBe(false);
  });
});

describe('paymentRequestFromJson', () => {
  it('parses the Java-wallet format (quantity)', () => {
    const req = paymentRequestFromJson({
      address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
      quantity: '0.5',
      tokenid: 'bc',
      memo: 'coffee',
    });
    expect(req).toEqual({
      address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
      amount: '0.5',
      tokenid: 'bc',
      memo: 'coffee',
    });
  });

  it('accepts amount / tokenId aliases and numeric amounts', () => {
    const req = paymentRequestFromJson({ address: 'abc', amount: 2, tokenId: 'TKN' });
    expect(req?.amount).toBe('2');
    expect(req?.tokenid).toBe('TKN');
  });

  it('drops invalid amounts', () => {
    const req = paymentRequestFromJson({ address: 'abc', quantity: 'lots' });
    expect(req?.amount).toBeUndefined();
  });

  it('returns null without an address', () => {
    expect(paymentRequestFromJson({ quantity: '1' })).toBeNull();
  });
});

describe('parseQrContent', () => {
  it('classifies a payment JSON request', () => {
    const res = parseQrContent('{"address":"abc","quantity":"0.001","tokenid":"bc","memo":"hi"}');
    expect(res.kind).toBe('payment');
    if (res.kind === 'payment') {
      expect(res.request.address).toBe('abc');
      expect(res.request.amount).toBe('0.001');
    }
  });

  it('classifies a plain address as a payment request', () => {
    const res = parseQrContent('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');
    expect(res.kind).toBe('payment');
    if (res.kind === 'payment') expect(res.request.address).toBe('n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs');
  });

  it('classifies web links as url', () => {
    const res = parseQrContent('https://wallet.bigt.ai/receive?address=abc&amount=1');
    expect(res.kind).toBe('url');
    if (res.kind === 'url') expect(res.url).toContain('wallet.bigt.ai');
  });

  it('returns unknown for unrecognized content', () => {
    expect(parseQrContent('just some text').kind).toBe('unknown');
    expect(parseQrContent('').kind).toBe('unknown');
    expect(parseQrContent('{broken json').kind).toBe('unknown');
  });
});
