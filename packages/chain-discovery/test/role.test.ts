import { describe, expect, it } from 'vitest';
import { REGISTRY_CHAIN, dnsSrvName, dnsTxtName, type ChainRole } from '../src/role.js';

describe('chain roles', () => {
  it('maps every role to its registry chain id', () => {
    expect(REGISTRY_CHAIN.l0).toBe('L0');
    expect(REGISTRY_CHAIN.l1).toBe('ordermatch');
    expect(REGISTRY_CHAIN.social).toBe('SOCIAL');
  });

  it('builds the published DNS seed names', () => {
    expect(dnsTxtName('l0', 'bigtangle.org')).toBe('_bigtangle-l0.bigtangle.org');
    expect(dnsSrvName('l1', 'bigtangle.org')).toBe('_bigtangle-l1._tcp.bigtangle.org');
    expect(dnsTxtName('social', 'bigtangle.org')).toBe('_bigtangle-social.bigtangle.org');
  });

  it('covers exactly l0 | l1 | social', () => {
    const roles: ChainRole[] = ['l0', 'l1', 'social'];
    expect(Object.keys(REGISTRY_CHAIN).sort()).toEqual([...roles].sort());
  });
});
