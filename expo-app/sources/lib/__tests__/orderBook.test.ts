import { describe, it, expect } from 'vitest';
import { p2pOrderRecord, p2pSwapRecord } from 'p2p-protocol';
import { foldOrderBook } from '../orderBook';
import type { SocialRecordEntry } from '../socialReader';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function openOrder(over: Partial<Parameters<typeof p2pOrderRecord>[0]> = {}): SocialRecordEntry {
  const record = p2pOrderRecord({
    from: 'did:key:zSeller',
    to: 'ord-0123456789abcdef',
    giveToken: 'bc',
    giveAmount: '10',
    giveChain: 'L0',
    wantCurrency: 'CNY',
    wantAmount: '715',
    wantRail: 'wechat',
    validUntil: NOW_SEC + 3600,
    ts: NOW_MS,
    ...over,
  });
  return { txid: 'tx-order-1', record: record as unknown as Record<string, unknown>, kind: 'order', verified: true };
}

function swapFor(orderId: string): SocialRecordEntry {
  return {
    txid: 'tx-swap-1',
    record: { type: 'social.p2p-swap', orderId, to: 'swap-0123456789abcdef' },
    kind: 'swap',
    verified: true,
  };
}

describe('foldOrderBook', () => {
  it('preserves exact partial remainders and only returns safely released reservations', () => {
    const order = openOrder({ giveAmount: '0.3', wantAmount: '0.3' });
    const match: SocialRecordEntry = {
      kind: 'swap', verified: true, txid: 'tx-match',
      record: p2pSwapRecord({
        from: 'did:key:zEngine', to: 'swap-0123456789abcdef', orderId: String(order.record.to),
        status: 'MATCHED', swapSeq: 0, giveAmount: '0.1', ts: NOW_MS,
      }) as unknown as Record<string, unknown>,
    };
    expect(foldOrderBook([order, match, match], { now: NOW_MS })[0].remainingGive).toBe('0.2');
    const cancelled = { ...match, record: { ...match.record, status: 'CANCELLED', swapSeq: 1 } };
    expect(foldOrderBook([cancelled, order, match], { now: NOW_MS })[0].remainingGive).toBe('0.3');
    const funded = { ...cancelled, record: { ...cancelled.record, escrowTxHash: 'a'.repeat(64) } };
    expect(foldOrderBook([order, match, funded], { now: NOW_MS })[0].remainingGive).toBe('0.2');
    const refunded = { ...funded, record: { ...funded.record, status: 'ESCROW_REFUNDED', swapSeq: 2, refundTxHash: 'b'.repeat(64) } };
    expect(foldOrderBook([refunded, order, funded, match], { now: NOW_MS })[0].remainingGive).toBe('0.3');
  });

  it('keeps a verified OPEN order and maps it to the UI shape', () => {
    const book = foldOrderBook([openOrder({ enginePubkey: '05' + 'ab'.repeat(2600) })], { now: NOW_MS });
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({
      orderId: 'ord-0123456789abcdef',
      sellerDid: 'did:key:zSeller',
      status: 'ACTIVE',
      giveToken: 'bc',
      wantRail: 'wechat',
      txid: 'tx-order-1',
    });
    expect(book[0].enginePubkey).toBe('05' + 'ab'.repeat(2600));
  });

  it('drops unverified records', () => {
    const e = openOrder();
    e.verified = false;
    expect(foldOrderBook([e], { now: NOW_MS })).toHaveLength(0);
  });

  it('drops expired orders', () => {
    expect(foldOrderBook([openOrder({ validUntil: NOW_SEC - 1 })], { now: NOW_MS })).toHaveLength(0);
  });

  it('drops an order withdrawn by a later CANCELLED record', () => {
    const cancelled: SocialRecordEntry = {
      txid: 'tx-cancel',
      record: p2pOrderRecord({
        from: 'did:key:zSeller',
        to: 'ord-0123456789abcdef',
        status: 'CANCELLED',
        orderSeq: 1,
        ts: NOW_MS,
      }) as unknown as Record<string, unknown>,
      kind: 'order',
      verified: true,
    };
    expect(foldOrderBook([openOrder(), cancelled], { now: NOW_MS })).toHaveLength(0);
  });

  it('drops an order a swap event has already claimed (MATCHED)', () => {
    expect(foldOrderBook([openOrder(), swapFor('ord-0123456789abcdef')], { now: NOW_MS })).toHaveLength(0);
  });

  it('sorts newest first', () => {
    const older = openOrder({ to: 'ord-0000000000000001', ts: NOW_MS - 60_000 });
    const newer = openOrder({ to: 'ord-0000000000000002', ts: NOW_MS });
    const book = foldOrderBook([older, newer], { now: NOW_MS });
    expect(book.map((o) => o.orderId)).toEqual(['ord-0000000000000002', 'ord-0000000000000001']);
  });

  it('ignores malformed / non-order records', () => {
    const garbage: SocialRecordEntry = { txid: 't', record: { type: 'social.p2p-order' }, kind: 'order', verified: true };
    const release: SocialRecordEntry = { txid: 't2', record: { type: 'social.p2p-release' }, kind: 'release', verified: true };
    expect(foldOrderBook([garbage, release], { now: NOW_MS })).toHaveLength(0);
  });
});
