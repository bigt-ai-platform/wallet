import { PQConstants } from './PQConstants';

export class KeyBundle {
  readonly version: number;
  readonly entries: KeyBundleEntry[];

  constructor(entries: KeyBundleEntry[], version: number = PQConstants.BUNDLE_VERSION) {
    this.version = version;
    this.entries = [...entries].sort((a, b) => a.algorithm - b.algorithm);
  }

  getEntry(algorithm: number): KeyBundleEntry | undefined {
    return this.entries.find(e => e.algorithm === algorithm);
  }

  serialize(): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(new Uint8Array([this.version]));
    parts.push(new Uint8Array([this.entries.length]));
    for (const e of this.entries) {
      const header = new Uint8Array(3);
      header[0] = e.algorithm;
      header[1] = (e.publicKey.length >>> 8) & 0xFF;
      header[2] = e.publicKey.length & 0xFF;
      parts.push(header);
      parts.push(e.publicKey);
    }
    return concatAll(parts);
  }

  static deserialize(bytes: Uint8Array): KeyBundle {
    if (bytes.length < 2) throw new Error("too short");
    const version = bytes[0];
    const count = bytes[1];
    const entries: KeyBundleEntry[] = [];
    let offset = 2;
    for (let i = 0; i < count; i++) {
      if (offset + 4 > bytes.length) throw new Error("truncated entry");
      const algorithm = bytes[offset++];
      const length = ((bytes[offset++] << 8) | bytes[offset++]) & 0xFFFF;
      if (offset + length > bytes.length) throw new Error("truncated key bytes");
      const pk = bytes.slice(offset, offset + length);
      offset += length;
      entries.push(new KeyBundleEntry(algorithm, pk));
    }
    if (version > PQConstants.BUNDLE_VERSION)
      throw new Error("unsupported bundle version: " + version);
    return new KeyBundle(entries, version);
  }
}

export class KeyBundleEntry {
  readonly algorithm: number;
  readonly publicKey: Uint8Array;

  constructor(algorithm: number, publicKey: Uint8Array) {
    this.algorithm = algorithm;
    this.publicKey = publicKey;
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
