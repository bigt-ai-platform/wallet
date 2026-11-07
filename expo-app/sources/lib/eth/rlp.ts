/**
 * Minimal RLP encoder (Ethereum yellow paper, appendix B) — the only piece of
 * the wire format the wallet needs for EIP-1559 transactions. Kept dependency
 * free and heavily unit-tested (vectors from the Ethereum wiki).
 */

export type RlpInput = Uint8Array | string | bigint | number | RlpInput[];

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Minimal big-endian bytes; 0 encodes as the empty string. */
function integerBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP cannot encode a negative integer');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function utf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function payloadBytes(input: Uint8Array | string | bigint | number): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return utf8(input);
  if (typeof input === 'bigint') return integerBytes(input);
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new Error('RLP number must be a safe integer');
    return integerBytes(BigInt(input));
  }
  throw new Error('Unsupported RLP input');
}

/** Length prefix: short form (<56 bytes) is a single byte, long form adds the
 * length-of-length bytes. `offset` is 0x80 for strings, 0xc0 for lists. */
function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return new Uint8Array([offset + length]);
  const lenBytes = integerBytes(BigInt(length));
  return concatBytes([new Uint8Array([offset + 55 + lenBytes.length]), lenBytes]);
}

export function rlpEncode(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const payload = concatBytes(input.map(rlpEncode));
    return concatBytes([lengthPrefix(payload.length, 0xc0), payload]);
  }
  const bytes = payloadBytes(input);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concatBytes([lengthPrefix(bytes.length, 0x80), bytes]);
}
