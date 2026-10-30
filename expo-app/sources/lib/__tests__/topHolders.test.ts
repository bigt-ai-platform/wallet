import { describe, expect, it } from 'vitest';
import { sumByAddress, TOP_HOLDERS_LIMIT } from '@/lib/topHolders';

/** `outputsOfTokenid` row as the server sends it (value = Java Coin object). */
const coin = (address: string, value: string) => ({ address, value: { value, tokenid: 'bc' } });

describe('sumByAddress (token rich list)', () => {
  it('sums the open outputs of one address (Java searchTotalNoSave)', () => {
    const rows = sumByAddress([
      coin('addrA', '100'),
      coin('addrA', '25'),
      coin('addrB', '200'),
    ]);
    expect(rows).toEqual([
      { address: 'addrB', total: 200n, count: 1 },
      { address: 'addrA', total: 125n, count: 2 },
    ]);
  });

  it('accepts a raw scalar value and skips empty addresses / non-positive rows', () => {
    const rows = sumByAddress([
      { address: 'addrA', value: '10' },
      { address: '', value: '999' },
      { value: '999' },
      { address: 'addrB', value: '0' },
      { address: 'addrC', value: '-5' },
    ]);
    expect(rows).toEqual([{ address: 'addrA', total: 10n, count: 1 }]);
  });

  it('keeps exact BigInt totals beyond Number.MAX_SAFE_INTEGER', () => {
    const rows = sumByAddress([
      coin('addrA', '99999901090400000'),
      coin('addrA', '1'),
    ]);
    expect(rows[0].total).toBe(99999901090400001n);
  });

  it('lists at most 50 addresses by default, largest first', () => {
    const outputs = Array.from({ length: 60 }, (_, i) => coin(`addr${i}`, String(i + 1)));
    const rows = sumByAddress(outputs);
    expect(TOP_HOLDERS_LIMIT).toBe(50);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ address: 'addr59', total: 60n, count: 1 });
    expect(rows[49]).toEqual({ address: 'addr10', total: 11n, count: 1 });
  });

  it('orders equal totals by address so the list is deterministic', () => {
    const rows = sumByAddress([coin('b', '5'), coin('a', '5'), coin('c', '5')]);
    expect(rows.map((r) => r.address)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for no outputs', () => {
    expect(sumByAddress([])).toEqual([]);
  });
});
