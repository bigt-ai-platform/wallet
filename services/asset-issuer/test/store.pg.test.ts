import { describe, expect, it } from 'vitest';
import { splitChainKey } from '../src/store.pg.js';

/**
 * Only the pure helper is tested: the queries need a real Postgres, which CI
 * does not provide. The key format is the idempotency contract, so it must be
 * pinned by a test.
 */
describe('chain key parsing', () => {
  it('splits chain, hash and log index', () => {
    expect(splitChainKey('ethereum:0xabc:3')).toEqual(['ethereum', '0xabc', 3]);
  });

  it('handles a chain id containing a colon', () => {
    expect(splitChainKey('l1:order:0xdead:0')).toEqual(['l1:order', '0xdead', 0]);
  });

  it('rejects malformed keys instead of guessing', () => {
    expect(() => splitChainKey('nope')).toThrow(/malformed/);
    expect(() => splitChainKey('chain:hash:notanumber')).toThrow(/malformed/);
    expect(() => splitChainKey(':hash:0')).toThrow(/malformed/);
  });
});
