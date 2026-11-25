// MessageDigest.ts
// Translation of java.security.MessageDigest

import { MessageDigestSpi } from "./MessageDigestSpi";

// Simple provider stub
interface Provider {
  name: string;
}

export abstract class MessageDigest extends MessageDigestSpi {
  protected algorithm: string;
  protected state: number = 0; // 0 = INITIAL, 1 = IN_PROGRESS
  protected provider?: any;    // Stub for Provider

  protected constructor(algorithm: string, provider?: any) {
    super();
    this.algorithm = algorithm;
    this.provider = provider;
  }

  // -----------------------
  // Update methods
  // -----------------------
  public updateByte(input: number): void {
    this.engineUpdateByte(input);
    this.state = 1;
  }

  public update(input: Uint8Array, offset: number = 0, len?: number): void {
    if (!input) {
      throw new Error("No input buffer given");
    }
    const length = len ?? input.length - offset;
    if (input.length - offset < length) {
      throw new Error("Input buffer too short");
    }
    this.engineUpdateBytes(input, offset, length);
    this.state = 1;
  }

  public updateBuffer(input: Uint8Array): void {
    if (!input) {
      throw new Error("Null input buffer");
    }
    this.engineUpdateBuffer(input);
    this.state = 1;
  }

  // -----------------------
  // Digest methods
  // -----------------------
  public digest(): Uint8Array {
    const result = this.engineDigest();
    this.state = 0;
    return result;
  }

  public digestInto(buf: Uint8Array, offset: number, len: number): number {
    if (!buf) {
      throw new Error("No output buffer given");
    }
    if (buf.length - offset < len) {
      throw new Error("Output buffer too small for specified offset and length");
    }
    const numBytes = this.engineDigestInto(buf, offset, len);
    this.state = 0;
    return numBytes;
  }

  public digestBytes(input: Uint8Array): Uint8Array {
    this.update(input);
    return this.digest();
  }

  // -----------------------
  // Utility methods
  // -----------------------
  public reset(): void {
    this.engineReset();
    this.state = 0;
  }

  public getAlgorithm(): string {
    return this.algorithm;
  }

  public getDigestLength(): number {
    const digestLen = this.engineGetDigestLength();
    if (digestLen === 0) {
      try {
        const md = this.clone() as MessageDigest;
        const digest = md.digest();
        return digest.length;
      } catch {
        return digestLen;
      }
    }
    return digestLen;
  }

  public clone(): MessageDigest {
    const copy = super.clone() as MessageDigest;
    copy.algorithm = this.algorithm;
    copy.state = this.state;
    copy.provider = this.provider;
    return copy;
  }

  public toString(): string {
    let stateStr = "";
    switch (this.state) {
      case 0: stateStr = "<initialized>"; break;
      case 1: stateStr = "<in progress>"; break;
    }
    return `${this.algorithm} Message Digest from ${this.provider?.name ?? "(no provider)"}, ${stateStr}`;
  }

  // -----------------------
  // Constant-time comparison
  // -----------------------
  public static isEqual(digesta: Uint8Array, digestb: Uint8Array): boolean {
    if (digesta === digestb) return true;
    if (!digesta || !digestb) return false;

    const lenA = digesta.length;
    const lenB = digestb.length;

    if (lenB === 0) {
      return lenA === 0;
    }

    let result = lenA - lenB;
    for (let i = 0; i < lenA; i++) {
      // indexB = 0 if i >= lenB
      const indexB = i < lenB ? i : 0;
      result |= digesta[i] ^ digestb[indexB];
    }
    return result === 0;
  }

  /**
   * Returns a MessageDigest object that implements the specified digest algorithm.
   *
   * @param algorithm the name of the algorithm requested
   * @return a MessageDigest object that implements the specified algorithm
   * @throws Error if no implementation for the specified algorithm is available
   */
  public static getInstance(algorithm: string): MessageDigest {
    // Simple factory method to create MessageDigest instances
    // For now, we'll throw an error and let the concrete implementations handle this
    throw new Error(`Unsupported algorithm: ${algorithm}. Use concrete implementation directly.`);
  }

  /**
   * Creates a MessageDigest instance for the specified algorithm.
   * This is a TypeScript translation of the Java MessageDigest.from() method.
   *
   * @param algorithm the name of the algorithm requested
   * @return a MessageDigest object that implements the specified algorithm
   * @throws Error if no implementation for the specified algorithm is available
   */
  public static from(algorithm: string): MessageDigest {
    // In a real implementation, this would use a more sophisticated provider mechanism
    // For now, we'll delegate to getInstance
    return MessageDigest.getInstance(algorithm);
  }
}
