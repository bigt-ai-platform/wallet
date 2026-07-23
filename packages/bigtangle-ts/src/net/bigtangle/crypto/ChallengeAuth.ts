import { PQKey } from '../crypto/pq/PQKey';
import { SignatureBundle } from '../crypto/pq/SignatureBundle';
import { Sha256Hash } from '../core/Sha256Hash';
import { Utils } from '../utils/Utils';
import { DidKey } from './DidKey';

const DEFAULT_CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;

export interface Challenge {
  nonce: string;
  expiresAt: number;
  did?: string;
}

export interface ChallengeResponse {
  did: string;
  nonce: string;
  signature: string;
}

export class ChallengeAuth {
  /**
   * Creates a cryptographically random challenge nonce.
   * @param expiryMs - Time in milliseconds until the challenge expires (default 5 minutes)
   */
  public static createChallenge(expiryMs: number = DEFAULT_CHALLENGE_EXPIRY_MS): Challenge {
    const nonceBytes = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(nonceBytes);
    } else {
      for (let i = 0; i < 32; i++) {
        nonceBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const nonce = Array.from(nonceBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return {
      nonce,
      expiresAt: Date.now() + expiryMs,
    };
  }

  /**
   * Signs a challenge nonce with the given PQKey.
   * The message signed is SHA-256(nonce).
   * Returns the signature as a hex-encoded serialized SignatureBundle.
   */
  public static async signChallenge(
    nonce: string,
    key: PQKey
  ): Promise<string> {
    const nonceBytes = hexToBytes(nonce);
    const messageHash = Sha256Hash.of(nonceBytes);
    const signature = key.sign(messageHash);
    return Utils.HEX.encode(signature.serialize());
  }

  /**
   * Verifies a signed challenge against a DID's public key.
   */
  public static verifyChallengeWithDid(
    did: string,
    nonce: string,
    signatureHex: string
  ): boolean {
    const pubKey = DidKey.toPQKey(did);
    return ChallengeAuth.verifyChallengeWithPublicKey(nonce, signatureHex, pubKey);
  }

  /**
   * Verifies a signed challenge against a raw public key.
   */
  public static verifyChallengeWithPublicKey(
    nonce: string,
    signatureHex: string,
    pubKey: PQKey
  ): boolean {
    const nonceBytes = hexToBytes(nonce);
    const messageHash = Sha256Hash.of(nonceBytes);
    const sigBytes = Utils.HEX.decode(signatureHex);
    const sigBundle = SignatureBundle.deserialize(sigBytes);
    return PQKey.verify(messageHash, sigBundle, pubKey.getPublicKeyBytes());
  }

  /**
   * Signs a challenge nonce and returns the complete challenge response.
   */
  public static async createResponse(
    did: string,
    nonce: string,
    key: PQKey
  ): Promise<ChallengeResponse> {
    const signature = await ChallengeAuth.signChallenge(nonce, key);
    return { did, nonce, signature };
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
