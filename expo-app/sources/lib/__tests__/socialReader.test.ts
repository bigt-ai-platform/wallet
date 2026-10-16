import { describe, it, expect } from 'vitest';
import { MainNetParams, Transaction } from 'bigtangle-ts';
import { P2P_ORDER_TYPE, P2P_RELEASE_TYPE, P2P_SWAP_TYPE } from 'p2p-protocol';
import {
  collectSocialRecords,
  classifySocialRecord,
  extractSocialRecord,
  extractSocialRecords,
  SOCIAL_DATA_CLASS,
  type SocialBlock,
  type SocialSource,
} from '../socialReader';

function socialTx(record: unknown, className: string | null = SOCIAL_DATA_CLASS): Transaction {
  const tx = new Transaction(MainNetParams.get());
  tx.setData(new TextEncoder().encode(JSON.stringify(record)));
  tx.setDataClassName(className);
  return tx;
}

describe('extractSocialRecord', () => {
  it('parses a SocialRecord tx', () => {
    const tx = socialTx({ type: P2P_ORDER_TYPE, from: 'did:key:zS', to: 'ord-0123456789abcdef' });
    const found = extractSocialRecord(tx);
    expect(found).not.toBeNull();
    expect(found!.record.type).toBe(P2P_ORDER_TYPE);
    expect(found!.txid).toBe(tx.getHash().toString());
  });

  it('ignores a non-SocialRecord class and empty data', () => {
    expect(extractSocialRecord(socialTx({ type: 'x' }, 'TokenInfo'))).toBeNull();
    const empty = new Transaction(MainNetParams.get());
    empty.setDataClassName(SOCIAL_DATA_CLASS);
    expect(extractSocialRecord(empty)).toBeNull();
  });

  it('yields a garbage record on malformed JSON', () => {
    const tx = new Transaction(MainNetParams.get());
    tx.setData(new TextEncoder().encode('{not json'));
    tx.setDataClassName(SOCIAL_DATA_CLASS);
    expect(extractSocialRecord(tx)!.record.type).toBe('__garbage__');
  });
});

describe('classifySocialRecord', () => {
  it('maps each P2P record family and defaults to other', () => {
    expect(classifySocialRecord({ type: P2P_ORDER_TYPE })).toBe('order');
    expect(classifySocialRecord({ type: P2P_SWAP_TYPE })).toBe('swap');
    expect(classifySocialRecord({ type: P2P_RELEASE_TYPE })).toBe('release');
    expect(classifySocialRecord({ type: 'social.group' })).toBe('other');
    expect(classifySocialRecord(null)).toBe('other');
    expect(classifySocialRecord({})).toBe('other');
  });
});

describe('extractSocialRecords', () => {
  it('keeps only SocialRecord txs, in order', () => {
    const txs = [
      socialTx({ type: P2P_ORDER_TYPE }),
      socialTx({ type: 'social.other' }, 'TokenInfo'),
      socialTx({ type: P2P_RELEASE_TYPE }),
    ];
    const out = extractSocialRecords(txs);
    expect(out.map((e) => e.kind)).toEqual(['order', 'release']);
    // no author sig on these → unverified, never trusted
    expect(out.every((e) => e.verified === false)).toBe(true);
  });
});

describe('collectSocialRecords', () => {
  const block = (hash: string, prevHash: string, entries: SocialBlock['entries']): SocialBlock =>
    ({ hash, prevHash, height: 0, entries });

  it('walks newest → oldest up to maxBlocks', async () => {
    const order: SocialBlock['entries'] = [{ txid: 't1', record: { type: P2P_ORDER_TYPE }, kind: 'order', verified: true }];
    const release: SocialBlock['entries'] = [{ txid: 't2', record: { type: P2P_RELEASE_TYPE }, kind: 'release', verified: true }];
    const src: SocialSource = {
      head: async () => ({ hash: 'b2' }),
      blockByHash: async (h) =>
        h === 'b2' ? block('b2', 'b1', release) : h === 'b1' ? block('b1', 'b0', order) : null,
    };
    const got = await collectSocialRecords(src, { maxBlocks: 10 });
    expect(got.map((e) => e.txid)).toEqual(['t2', 't1']);
  });

  it('stops at maxBlocks and on a missing block', async () => {
    const one: SocialBlock['entries'] = [{ txid: 't1', record: { type: P2P_ORDER_TYPE }, kind: 'order', verified: true }];
    const src: SocialSource = {
      head: async () => ({ hash: 'b1' }),
      blockByHash: async (h) => (h === 'b1' ? block('b1', 'b0', one) : null),
    };
    expect((await collectSocialRecords(src, { maxBlocks: 1 })).map((e) => e.txid)).toEqual(['t1']);
  });

  it('does not loop on a self-referential prev hash', async () => {
    const one: SocialBlock['entries'] = [{ txid: 't1', record: { type: P2P_SWAP_TYPE }, kind: 'swap', verified: true }];
    const src: SocialSource = {
      head: async () => ({ hash: 'b1' }),
      blockByHash: async () => block('b1', 'b1', one),
    };
    expect((await collectSocialRecords(src, { maxBlocks: 5 })).length).toBe(1);
  });
});
