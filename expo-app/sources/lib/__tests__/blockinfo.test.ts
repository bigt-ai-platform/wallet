import { describe, expect, it } from 'vitest';
import {
  base64ToBytes, bytesToHex, evaluationHashHex, toBlockRow,
} from '../blockinfo';

// 32 bytes 0x00..0x1f
const HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const B64 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i),
).toString('base64');

describe('blockinfo', () => {
  it('base64ToBytes decodes standard base64', () => {
    expect(bytesToHex(base64ToBytes(B64))).toBe(HEX);
    expect(bytesToHex(base64ToBytes(''))).toBe('');
    expect(bytesToHex(base64ToBytes('QQ=='))).toBe('41');
  });

  it('bytesToHex pads single digits', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 255]))).toBe('00010fff');
  });

  it('evaluationHashHex handles the Jackson Sha256Hash object', () => {
    const evaluation = { blockHash: { bytes: B64, reversedBytes: 'zzz' } };
    expect(evaluationHashHex(evaluation)).toBe(HEX);
  });

  it('evaluationHashHex handles hex strings and number arrays', () => {
    expect(evaluationHashHex({ blockHash: HEX })).toBe(HEX);
    expect(evaluationHashHex({ blockHash: { bytes: [0, 1] } })).toBe('0001');
    expect(evaluationHashHex({})).toBe('');
    expect(evaluationHashHex(null)).toBe('');
  });

  it('toBlockRow normalizes an evaluation row', () => {
    const row = toBlockRow({
      blockHash: { bytes: B64 },
      height: '42',
      chainlength: 100,
      totalrating: 1234.5,
      confirmed: true,
      blockType: 'BLOCKTYPE_REWARD',
      insertTime: 1700000000000,
      milestoneLastUpdateTime: 1700000001000,
    });
    expect(row).toEqual({
      hash: HEX,
      height: 42,
      chainlength: 100,
      rating: '1234.5',
      confirmed: true,
      blockType: 'BLOCKTYPE_REWARD',
      insertTime: 1700000000000,
      milestoneLastUpdateTime: 1700000001000,
    });
  });

  it('toBlockRow is robust against missing fields', () => {
    const row = toBlockRow({});
    expect(row.height).toBe(0);
    expect(row.rating).toBe('');
    expect(row.confirmed).toBe(false);
    expect(row.blockType).toBe('');
  });
});
