import { PQConstants } from './PQConstants';

export const DEFAULT_SIGHASH_BYTE = 0x01; // SIGHASH_ALL

export class SignatureBundle {
  readonly version: number;
  readonly entries: SignatureBundleEntry[];

  constructor(entries: SignatureBundleEntry[], version: number = PQConstants.BUNDLE_VERSION) {
    this.version = version;
    this.entries = [...entries].sort((a, b) => a.algorithm - b.algorithm);
  }

  /** Encode as serialized bundle + trailing sighash byte (bitcoin-like format) */
  encodeToBitcoin(sighashByte: number = DEFAULT_SIGHASH_BYTE): Uint8Array {
    const raw = this.serialize();
    const out = new Uint8Array(raw.length + 1);
    out.set(raw, 0);
    out[raw.length] = sighashByte;
    return out;
  }

  /** Decode from serialized bundle + trailing sighash byte */
  static decodeFromBitcoin(bytes: Uint8Array): { bundle: SignatureBundle; sighashByte: number } {
    const sighashByte = bytes[bytes.length - 1];
    const bundleBytes = bytes.slice(0, -1);
    return { bundle: SignatureBundle.deserialize(bundleBytes), sighashByte };
  }

  getEntry(algorithm: number): SignatureBundleEntry | undefined {
    return this.entries.find(e => e.algorithm === algorithm);
  }

  serialize(): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(new Uint8Array([this.version]));
    parts.push(new Uint8Array([this.entries.length]));
    for (const e of this.entries) {
      const header = new Uint8Array(3);
      header[0] = e.algorithm;
      header[1] = (e.signature.length >>> 8) & 0xFF;
      header[2] = e.signature.length & 0xFF;
      parts.push(header);
      parts.push(e.signature);
    }
    return concatAll(parts);
  }

  static deserialize(bytes: Uint8Array): SignatureBundle {
    if (bytes.length < 2) throw new Error("too short");
    const version = bytes[0];
    const count = bytes[1];
    const entries: SignatureBundleEntry[] = [];
    let offset = 2;
    for (let i = 0; i < count; i++) {
      if (offset + 4 > bytes.length) throw new Error("truncated entry");
      const algorithm = bytes[offset++];
      const length = ((bytes[offset++] << 8) | bytes[offset++]) & 0xFFFF;
      if (offset + length > bytes.length) throw new Error("truncated sig bytes");
      const sig = bytes.slice(offset, offset + length);
      offset += length;
      entries.push(new SignatureBundleEntry(algorithm, sig));
    }
    if (version > PQConstants.BUNDLE_VERSION)
      throw new Error("unsupported bundle version: " + version);
    return new SignatureBundle(entries, version);
  }
}

export class SignatureBundleEntry {
  readonly algorithm: number;
  readonly signature: Uint8Array;

  constructor(algorithm: number, signature: Uint8Array) {
    this.algorithm = algorithm;
    this.signature = signature;
  }
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}
