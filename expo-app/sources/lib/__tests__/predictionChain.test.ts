import { describe, it, expect } from 'vitest';
import { resolvePredictionUrl, pointsAtOrderChain } from '../predictionChain';

const PRED = '/l1p/';

describe('resolvePredictionUrl', () => {
  it('keeps a real prediction node (custom or default)', () => {
    expect(resolvePredictionUrl('/l1p/', PRED)).toBe('/l1p/');
    expect(resolvePredictionUrl('https://predicteu1.bigtangle.org/', PRED)).toBe('https://predicteu1.bigtangle.org/');
    expect(resolvePredictionUrl('https://pred.example.org/l1p/', PRED)).toBe('https://pred.example.org/l1p/');
  });

  it('moves every order-chain base onto the prediction default', () => {
    for (const order of [
      '/l1/',
      '/l1',
      'https://ordereu1.bigtangle.org/',
      'https://ordereu2.bigtangle.org',
      'https://orderhk1.bigtangle.org/',
      'https://92.5.34.128/l1/',
      'https://m.bigtangle.org',
    ]) {
      expect(resolvePredictionUrl(order, PRED), order).toBe(PRED);
    }
  });

  it('falls back to the default when nothing is stored', () => {
    expect(resolvePredictionUrl('', PRED)).toBe(PRED);
    expect(resolvePredictionUrl(undefined, PRED)).toBe(PRED);
  });

  it('treats the relay root and other chains as custom', () => {
    // The relay /l0/ is L0, not the prediction chain — leave it alone (a user
    // who typed it gets the URL they typed).
    expect(resolvePredictionUrl('https://92.5.34.128/l0/', PRED)).toBe('https://92.5.34.128/l0/');
    expect(pointsAtOrderChain('https://92.5.34.128/l0/')).toBe(false);
    expect(pointsAtOrderChain('https://ordereu1.bigtangle.org')).toBe(true);
    expect(pointsAtOrderChain('/l1p/')).toBe(false);
  });
});
