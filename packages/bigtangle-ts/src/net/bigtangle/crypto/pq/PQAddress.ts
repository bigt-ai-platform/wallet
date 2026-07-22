import { PQConstants } from './PQConstants';
import { KeyBundle } from './KeyBundle';
import { Sha256Hash } from '../../core/Sha256Hash';
import { Utils } from '../../core/Utils';

const ADDRESS_BYTES = 35;

export class PQAddress {
  readonly version: number;
  readonly network: number;
  readonly suite: number;
  readonly hash: Uint8Array;

  constructor(version: number, network: number, suite: number, hash: Uint8Array) {
    if (hash.length !== PQConstants.ADDRESS_HASH_BYTES)
      throw new Error("hash must be 32 bytes");
    this.version = version;
    this.network = network;
    this.suite = suite;
    this.hash = hash;
  }

  static fromKeyBundle(network: number, suite: number, keyBundle: KeyBundle): PQAddress {
    const bundleBytes = keyBundle.serialize();
    const hash = Sha256Hash.hash(bundleBytes);
    return new PQAddress(PQConstants.ADDRESS_VERSION, network, suite, hash);
  }

  static fromSerializedBundle(network: number, suite: number, bundleBytes: Uint8Array): PQAddress {
    const hash = Sha256Hash.hash(bundleBytes);
    return new PQAddress(PQConstants.ADDRESS_VERSION, network, suite, hash);
  }

  matches(keyBundle: KeyBundle): boolean {
    const bundleBytes = keyBundle.serialize();
    const computed = Sha256Hash.hash(bundleBytes);
    return arraysEqual(this.hash, computed);
  }

  serialize(): Uint8Array {
    const result = new Uint8Array(ADDRESS_BYTES);
    result[0] = this.version;
    result[1] = this.network;
    result[2] = this.suite;
    result.set(this.hash, 3);
    return result;
  }

  static deserialize(bytes: Uint8Array): PQAddress {
    if (bytes.length !== ADDRESS_BYTES) throw new Error("address must be 35 bytes");
    const version = bytes[0];
    const network = bytes[1];
    const suite = bytes[2];
    const hash = bytes.slice(3, ADDRESS_BYTES);
    return new PQAddress(version, network, suite, hash);
  }

  toHex(): string {
    return Utils.HEX.encode(this.serialize());
  }

  static fromHex(hex: string): PQAddress {
    return PQAddress.deserialize(Utils.HEX.decode(hex));
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
