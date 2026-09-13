/**
 * Normalization helpers for the block explorer screen.
 *
 * The server's `findBlockEvaluation` / `searchBlockByBlockHashs` responses
 * carry raw `BlockEvaluationDisplay` JSON, where the block hash is a
 * Sha256Hash object (Jackson serializes its byte getters as base64 strings).
 * The UI needs the plain hex hash — the same string Java's
 * `blockEvaluation.getBlockHash().toString()` shows on the web block page.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Minimal dependency-free base64 decoder (Jackson byte[] → base64 string). */
export function base64ToBytes(b64: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    if (ch === '=' || ch === undefined) break;
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The hex block hash of a raw evaluation row. Handles every shape the server
 * may deliver: hex string, Sha256Hash object with base64/number-array bytes,
 * or `{ data: base64 }` (Jackson byte[] getter name variants).
 */
export function evaluationHashHex(evaluation: any): string {
  if (!evaluation) return '';
  const h = evaluation.blockHash;
  if (typeof h === 'string') return h;
  if (h && typeof h === 'object') {
    const raw = h.bytes ?? h.reversedBytes ?? h.data;
    if (typeof raw === 'string') return bytesToHex(base64ToBytes(raw));
    if (Array.isArray(raw)) return bytesToHex(new Uint8Array(raw));
  }
  return '';
}

/** One normalized block row for the explorer list. */
export interface BlockRow {
  hash: string;
  height: number;
  /** Chainlength of the block (Java page's "depth" column). */
  chainlength: number;
  rating: string;
  confirmed: boolean;
  blockType: string;
  insertTime: number;
  milestoneLastUpdateTime: number;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalize one raw BlockEvaluationDisplay JSON row for rendering. */
export function toBlockRow(evaluation: any): BlockRow {
  const rating = evaluation?.totalrating;
  return {
    hash: evaluationHashHex(evaluation),
    height: num(evaluation?.height),
    chainlength: num(evaluation?.chainlength),
    rating: rating == null ? '' : String(rating),
    confirmed: !!evaluation?.confirmed,
    blockType: evaluation?.blockType ?? '',
    insertTime: num(evaluation?.insertTime),
    milestoneLastUpdateTime: num(evaluation?.milestoneLastUpdateTime),
  };
}
