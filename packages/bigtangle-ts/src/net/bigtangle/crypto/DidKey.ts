import { ECKey } from '../core/ECKey';
import { Base58 } from '../utils/Base58';
import { Utils } from '../utils/Utils';
import { sha256 } from '@noble/hashes/sha256';

const MULTICODEC_SECP256K1_PUB = 0xe7;

function encodeUvarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

function decodeUvarint(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < data.length) {
    const byte = data[i];
    value |= (byte & 0x7f) << shift;
    i++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value, length: i - offset };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return result;
}

const DID_KEY_PREFIX = 'did:key:';

export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: DidVerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  keyAgreement: string[];
}

export interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyBase58: string;
}

export class DidKey {
  /**
   * Creates a did:key identifier from an ECKey's public key.
   * Uses secp256k1 multicodec (0xe7) and multibase base58btc.
   */
  public static fromECKey(key: ECKey): string {
    const pubKeyBytes = key.getPubKey();
    return DidKey.fromPublicKeyBytes(pubKeyBytes);
  }

  /**
   * Creates a did:key from raw public key bytes (33-byte compressed secp256k1 public key).
   */
  public static fromPublicKeyBytes(pubKeyBytes: Uint8Array): string {
    const multicodec = encodeUvarint(MULTICODEC_SECP256K1_PUB);
    const combined = new Uint8Array(multicodec.length + pubKeyBytes.length);
    combined.set(multicodec, 0);
    combined.set(pubKeyBytes, multicodec.length);

    const base58 = Base58.encode(combined);
    return `${DID_KEY_PREFIX}z${base58}`;
  }

  /**
   * Extracts raw public key bytes (33 bytes, compressed) from a did:key string.
   */
  public static getPublicKeyBytes(did: string): Uint8Array {
    if (!did.startsWith(DID_KEY_PREFIX)) {
      throw new Error(`Invalid DID: must start with "${DID_KEY_PREFIX}"`);
    }
    const afterPrefix = did.slice(DID_KEY_PREFIX.length);
    if (!afterPrefix.startsWith('z')) {
      throw new Error('Invalid DID: unsupported multibase encoding (expected "z" for base58btc)');
    }
    const base58Str = afterPrefix.slice(1);
    const decoded = Base58.decode(base58Str);

    const { value: codec, length } = decodeUvarint(decoded, 0);
    if (codec !== MULTICODEC_SECP256K1_PUB) {
      throw new Error(`Invalid DID: expected multicodec 0x${MULTICODEC_SECP256K1_PUB.toString(16)}, got 0x${codec.toString(16)}`);
    }

    const keyBytes = decoded.slice(length);
    if (keyBytes.length !== 33) {
      throw new Error(`Invalid DID: expected 33-byte compressed public key, got ${keyBytes.length} bytes`);
    }
    return keyBytes;
  }

  /**
   * Creates an ECKey (public-only) from a did:key string.
   */
  public static toECKey(did: string): ECKey {
    const pubKeyBytes = DidKey.getPublicKeyBytes(did);
    return ECKey.fromPublic(pubKeyBytes, true);
  }

  /**
   * Resolves a did:key to a DID document (W3C DID Core compliant).
   */
  public static resolve(did: string): DidDocument {
    if (!did.startsWith(DID_KEY_PREFIX)) {
      throw new Error(`Invalid DID: must start with "${DID_KEY_PREFIX}"`);
    }
    const afterPrefix = did.slice(DID_KEY_PREFIX.length);
    if (!afterPrefix.startsWith('z')) {
      throw new Error('Invalid DID: unsupported multibase encoding (expected "z" for base58btc)');
    }
    const base58Str = afterPrefix.slice(1);
    const decoded = Base58.decode(base58Str);

    const { value: codec, length } = decodeUvarint(decoded, 0);
    if (codec !== MULTICODEC_SECP256K1_PUB) {
      throw new Error(`Invalid DID: expected multicodec 0xe7, got 0x${codec.toString(16)}`);
    }
    const pubKeyBytes = decoded.slice(length);

    const publicKeyBase58 = Base58.encode(pubKeyBytes);
    const fingerprint = DidKey.fingerprint(pubKeyBytes);
    const vmId = `${did}#${fingerprint}`;

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1-2019/v1',
      ],
      id: did,
      verificationMethod: [
        {
          id: vmId,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: did,
          publicKeyBase58,
        },
      ],
      authentication: [vmId],
      assertionMethod: [vmId],
      keyAgreement: [vmId],
    };
  }

  /**
   * Creates a short fingerprint identifier from public key bytes.
   */
  private static fingerprint(pubKeyBytes: Uint8Array): string {
    const hash = sha256(pubKeyBytes);
    return Base58.encode(hash.slice(0, 16));
  }

  /**
   * Verifies that a DID is well-formed and has valid multicodec.
   */
  public static isValid(did: string): boolean {
    try {
      DidKey.getPublicKeyBytes(did);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a did:key from private key bytes (32 bytes).
   */
  public static fromPrivateKeyBytes(privKeyBytes: Uint8Array): string {
    const key = ECKey.fromPrivateByte(privKeyBytes);
    return DidKey.fromECKey(key);
  }
}
