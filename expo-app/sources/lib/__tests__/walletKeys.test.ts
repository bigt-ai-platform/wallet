import { describe, expect, it } from 'vitest';
import {
  allKeys, bigtangleKey, ethereumKey, needsEthereumKey, needsPostQuantumKey,
  signingKeys, walletAddresses, withKey, type WalletKey,
} from '../walletKeys';

const pq = (id = 'pq'): WalletKey => ({
  address: `pq-${id}`, pubkey: 'aa', privateKey: `pq-priv-${id}`, keyType: 'PQ',
});
const ec = (id = 'ec'): WalletKey => ({
  address: `ec-${id}`, pubkey: '02', privateKey: `ec-priv-${id}`, keyType: 'EC', network: 'Main',
});

describe('wallet key roles', () => {
  it('lists every key, primary first, without duplicates', () => {
    expect(allKeys({ wallet: pq(), keys: [pq(), ec()] }).map((k) => k.address)).toEqual([
      'pq-pq',
      'ec-ec',
    ]);
  });

  it('picks the PQ key for Bigtangle and the EC key for Ethereum', () => {
    const w = { wallet: pq(), keys: [pq(), ec()] };
    expect(bigtangleKey(w).keyType).toBe('PQ');
    expect(ethereumKey(w)?.keyType).toBe('EC');
  });

  it('uses the EC key as the Bigtangle key in a legacy wallet', () => {
    const w = { wallet: ec(), keys: [ec()] };
    expect(bigtangleKey(w).keyType).toBe('EC');
    expect(ethereumKey(w)?.keyType).toBe('EC');
    expect(needsPostQuantumKey(w)).toBe(true);
    expect(needsEthereumKey(w)).toBe(false);
  });

  it('reports a PQ-only wallet as needing an Ethereum key', () => {
    const w = { wallet: pq(), keys: [pq()] };
    expect(needsEthereumKey(w)).toBe(true);
    expect(needsPostQuantumKey(w)).toBe(false);
    expect(ethereumKey(w)).toBeNull();
  });

  it('adds a key by role and keeps the Bigtangle key primary', () => {
    const pqOnly = { wallet: pq(), keys: [pq()] };
    const dual = withKey(pqOnly, ec());
    expect(allKeys(dual)).toHaveLength(2);
    expect(dual.wallet.address).toBe('pq-pq');
    expect(ethereumKey(dual)?.address).toBe('ec-ec');

    const ecOnly = { wallet: ec(), keys: [ec()] };
    const upgraded = withKey(ecOnly, pq());
    expect(upgraded.wallet.keyType).toBe('PQ');
    expect(bigtangleKey(upgraded).keyType).toBe('PQ');
    expect(needsPostQuantumKey(upgraded)).toBe(false);
    // The legacy EC key survives, so old funds stay reachable.
    expect(allKeys(upgraded).map((k) => k.keyType)).toEqual(['PQ', 'EC']);
  });

  it('replaces a same-role key when adding another', () => {
    const dual = withKey({ wallet: pq(), keys: [pq(), ec('one')] }, ec('two'));
    expect(allKeys(dual).filter((k) => k.keyType === 'EC').map((k) => k.address)).toEqual(['ec-two']);
  });

  it('lists every address for per-address chain queries', () => {
    const dual = withKey({ wallet: pq(), keys: [pq()] }, ec());
    expect(walletAddresses(dual)).toEqual(['pq-pq', 'ec-ec']);
    expect(walletAddresses({ wallet: pq(), keys: [pq(), pq()] })).toEqual(['pq-pq']);
  });

  it('returns signing material for every key', () => {
    const dual = withKey({ wallet: pq(), keys: [pq()] }, ec());
    expect(signingKeys(dual)).toEqual([
      { privateKeyHex: 'pq-priv-pq', keyType: 'PQ' },
      { privateKeyHex: 'ec-priv-ec', keyType: 'EC' },
    ]);
  });
});
