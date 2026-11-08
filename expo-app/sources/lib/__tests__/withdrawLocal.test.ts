import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_ADDRESSES, MAX_WITHDRAWALS, addSavedAddress, hasSavedAddress,
  isSavedAddress, isWithdrawalRecord, parseList, pendingWithdrawals,
  removeSavedAddress, setWithdrawalStatus, upsertWithdrawal,
  type SavedAddress, type WithdrawalRecord,
} from '../withdrawLocal';

const ADDR = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const OTHER = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

const rec = (hash: string, status: WithdrawalRecord['status'] = 'pending'): WithdrawalRecord => ({
  hash, symbol: 'USDT', amount: '1.5', to: ADDR, network: 'Ethereum', at: 1, status,
});

describe('saved withdrawal addresses', () => {
  it('adds newest first and deduplicates case-insensitively', () => {
    const list = addSavedAddress([], ADDR, ' Binance ', 10);
    expect(list).toEqual([{ address: ADDR, label: 'Binance', addedAt: 10 }]);

    const relabelled = addSavedAddress(list, ADDR.toLowerCase(), 'Exchange', 20);
    expect(relabelled).toEqual([{ address: ADDR.toLowerCase(), label: 'Exchange', addedAt: 20 }]);
  });

  it('drops a blank label and caps the list', () => {
    expect(addSavedAddress([], ADDR, '   ', 1)[0].label).toBeUndefined();
    let list: SavedAddress[] = [];
    for (let i = 0; i < MAX_SAVED_ADDRESSES + 5; i++) {
      list = addSavedAddress(list, `0x${i.toString(16).padStart(40, '0')}`);
    }
    expect(list).toHaveLength(MAX_SAVED_ADDRESSES);
  });

  it('removes and finds addresses regardless of case', () => {
    const list = addSavedAddress([], ADDR);
    expect(hasSavedAddress(list, ADDR.toLowerCase())).toBe(true);
    expect(removeSavedAddress(list, ADDR.toLowerCase())).toEqual([]);
  });
});

describe('withdrawal history', () => {
  it('upserts by hash, newest first, capped', () => {
    let list: WithdrawalRecord[] = [];
    list = upsertWithdrawal(list, rec('0xaa'));
    list = upsertWithdrawal(list, rec('0xbb'));
    expect(list.map((r) => r.hash)).toEqual(['0xbb', '0xaa']);

    list = upsertWithdrawal(list, { ...rec('0xaa'), status: 'success' });
    expect(list.map((r) => [r.hash, r.status])).toEqual([
      ['0xaa', 'success'],
      ['0xbb', 'pending'],
    ]);

    for (let i = 0; i < MAX_WITHDRAWALS + 3; i++) list = upsertWithdrawal(list, rec(`0x${i}`));
    expect(list).toHaveLength(MAX_WITHDRAWALS);
  });

  it('updates a status and lists only pending rows', () => {
    const list = [rec('a'), rec('b', 'success')];
    expect(setWithdrawalStatus(list, 'a', 'failed')[0].status).toBe('failed');
    expect(pendingWithdrawals(list).map((r) => r.hash)).toEqual(['a']);
  });
});

describe('persisted JSON parsing', () => {
  it('ignores malformed rows and bad JSON', () => {
    expect(parseList('not json', isSavedAddress)).toEqual([]);
    expect(parseList('{"a":1}', isSavedAddress)).toEqual([]);
    expect(
      parseList(
        JSON.stringify([{ address: ADDR, addedAt: 1 }, { nope: true }]),
        isSavedAddress
      )
    ).toEqual([{ address: ADDR, addedAt: 1 }]);
  });

  it('validates withdrawal rows', () => {
    expect(isWithdrawalRecord(rec('x'))).toBe(true);
    expect(isWithdrawalRecord({ ...rec('x'), status: 'weird' })).toBe(false);
    expect(isWithdrawalRecord({ hash: 'x' })).toBe(false);
  });
});
