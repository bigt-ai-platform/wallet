import { describe, expect, it } from 'vitest';
import { layerLabel } from '../layerLabel';
import type { L1ChainConfig } from '@/types/api';

const chain = (chainId: string, name = ''): L1ChainConfig => ({ chainId, name, url: '' });

const chains = [
  chain('ordermatch', 'Main'),
  chain('prediction', 'Predict'),
  chain('custom', 'My Chain'),
  chain('anon'),
];

describe('layerLabel', () => {
  it('labels L0 and the built-in chains by role, not network name', () => {
    expect(layerLabel(0, chains)).toBe('L0');
    expect(layerLabel(1, chains)).toBe('L1-order');
    expect(layerLabel(2, chains)).toBe('L1-Prediction');
  });

  it('keeps a custom chain name, then falls back to its id and index', () => {
    expect(layerLabel(3, chains)).toBe('L1-My Chain');
    expect(layerLabel(4, chains)).toBe('L1-anon');
    expect(layerLabel(5, chains)).toBe('L1-5');
    expect(layerLabel(1, [])).toBe('L1-1');
  });
});
