import base58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { BaseEncoding } from "../utils/BaseEncoding";
import { Sha256Hash } from "./Sha256Hash";
import { Utils as UtilsHelper } from "../utils/Utils";

// Define helper functions for compatibility
export function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBuffer(hex: string): Uint8Array {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return new Uint8Array(bytes);
}

export function concatBuffers(buffer1: Uint8Array, buffer2: Uint8Array): Uint8Array {
  const result = new Uint8Array(buffer1.length + buffer2.length);
  result.set(buffer1, 0);
  result.set(buffer2, buffer1.length);
  return result;
}

export function reverseArray(arr: Uint8Array): Uint8Array {
  const result = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    result[i] = arr[arr.length - 1 - i];
  }
  return result;
}

export function allocBuffer(size: number): Uint8Array {
  return new Uint8Array(size);
}

export function readUInt32LE(buffer: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error(
      `Utils.readUInt32LE: not enough bytes to read uint32 at offset=${offset}, buffer length=${buffer.length}`
    );
  }
  const value = buffer[offset] +
         (buffer[offset + 1] * 256) +
         (buffer[offset + 2] * 65536) +
         (buffer[offset + 3] * 16777216);
  return value >>> 0;  // Force unsigned 32-bit interpretation
}

export function readBigUInt64LE(buffer: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new Error(
      `Utils.readBigUInt64LE: not enough bytes to read uint64 at offset=${offset}, buffer length=${buffer.length}`
    );
  }
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result += BigInt(buffer[offset + i]) << BigInt(i * 8);
  }
  return result;
}

// Helper functions for Uint8Array compatibility
export function equals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export function copy(source: Uint8Array, dest: Uint8Array, destStart: number = 0, srcStart: number = 0, srcEnd?: number): void {
    srcEnd = srcEnd ?? source.length;
    for (let i = srcStart; i < srcEnd; i++) {
        dest[destStart + i - srcStart] = source[i];
    }
}

export function readUInt8(arr: Uint8Array, offset: number): number {
    return arr[offset];
}

export function readUInt16LE(arr: Uint8Array, offset: number): number {
    return (arr[offset]) | (arr[offset + 1] << 8);
}


export function readInt32BE(arr: Uint8Array, offset: number): number {
    return (arr[offset] << 24) |
           (arr[offset + 1] << 16) |
           (arr[offset + 2] << 8) |
           arr[offset + 3];
}


export function writeUInt32LE(arr: Uint8Array, value: number, offset: number): void {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
    arr[offset + 2] = (value >>> 16) & 0xff;
    arr[offset + 3] = (value >>> 24) & 0xff;
}

export function writeUInt32BE(arr: Uint8Array, value: number, offset: number): void {
    arr[offset] = (value >>> 24) & 0xff;
    arr[offset + 1] = (value >>> 16) & 0xff;
    arr[offset + 2] = (value >>> 8) & 0xff;
    arr[offset + 3] = value & 0xff;
}

export function writeUInt16LE(arr: Uint8Array, value: number, offset: number): void {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
}

export function writeBigUInt64LE(arr: Uint8Array, value: bigint, offset: number): void {
    for (let i = 0; i < 8; i++) {
        arr[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
    }
}

export class Utils {
  public static readonly HEX = BaseEncoding.base16().lowerCase();

  public static base58ToBytes(base58String: string): Uint8Array {
    return Uint8Array.from(base58.decode(base58String));
  }

  public static bytesToBase58(bytes: Uint8Array): string {
    return base58.encode(bytes);
  }

  public static toHexString(bytes: Uint8Array): string {
    return bufferToHex(bytes);
  }

  public static reverseBytes(bytes: Uint8Array): Uint8Array {
    return reverseArray(bytes);
  }

  public static doubleDigest(buffer: Uint8Array): Uint8Array {
    const inputBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const first = sha256(inputBytes);
    const second = sha256(first);
    return new Uint8Array(second);
  }

  public static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  public static uint32ToByteStreamLE(value: number, stream: any): void {
    // Handle Bitcoin protocol convention where -1 represents 0xFFFFFFFF
    if (value === -1) {
      value = 0xFFFFFFFF;
    } else if (value < 0 || value > 0xffffffff) {
      throw new RangeError(`Value out of range: ${value}`);
    }

    const buffer = allocBuffer(4);
    buffer[0] = value & 0xff;
    buffer[1] = (value >>> 8) & 0xff;
    buffer[2] = (value >>> 16) & 0xff;
    buffer[3] = (value >>> 24) & 0xff;

    stream.write(buffer);
  }

  public static int64ToByteStreamLE(value: bigint, stream: any): void {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new RangeError(`Value out of range for uint64: ${value}`);
    }

    const buffer = allocBuffer(8);
    buffer[0] = Number(value & 0xffn);
    buffer[1] = Number((value >> 8n) & 0xffn);
    buffer[2] = Number((value >> 16n) & 0xffn);
    buffer[3] = Number((value >> 24n) & 0xffn);
    buffer[4] = Number((value >> 32n) & 0xffn);
    buffer[5] = Number((value >> 40n) & 0xffn);
    buffer[6] = Number((value >> 48n) & 0xffn);
    buffer[7] = Number((value >> 56n) & 0xffn);

    stream.write(buffer);
  }

  public static readUint32(buffer: Uint8Array, offset: number): number {
    if (!buffer || buffer.length === 0) {
      throw new Error("Buffer is empty");
    }
    if (offset < 0 || offset + 4 > buffer.length) {
      throw new Error(
        `Utils.readUint32: not enough bytes to read uint32 at offset=${offset}, buffer length=${buffer.length}`
      );
    }
    return readUInt32LE(buffer, offset);
  }

  public static readInt64(buffer: Uint8Array, offset: number): bigint {
    if (offset + 8 > buffer.length) {
      return 0n;
    }
    const value = readBigUInt64LE(buffer, offset);
    // Convert to signed BigInt
    if (value >= 0x8000000000000000n) {
      return value - 0x10000000000000000n;
    }
    return value;
  }

  public static reverseDwordBytes(bytes: Uint8Array, length: number): Uint8Array {
    if (length <= 0) {
      // Handle negative or zero length
      return allocBuffer(0);
    }
    const buf = allocBuffer(length);
    // Process complete 4-byte chunks
    const chunkCount = Math.floor(length / 4);
    for (let i = 0; i < chunkCount; i++) {
      const offset = i * 4;
      // Read 32-bit value from bytes in big endian format
      const value = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
      // Write the value in little endian format to buf
      buf[offset] = value & 0xff;
      buf[offset + 1] = (value >> 8) & 0xff;
      buf[offset + 2] = (value >> 16) & 0xff;
      buf[offset + 3] = (value >> 24) & 0xff;
    }

    // Copy any remaining bytes that don't form a complete dword
    const remainingStart = chunkCount * 4;
    const remainingBytes = length - remainingStart;
    if (remainingBytes > 0) {
      for (let i = 0; i < remainingBytes; i++) {
        buf[remainingStart + i] = bytes[remainingStart + i];
      }
    }

    return buf;
  }

  public static dateTimeFormat(date: number | Date): string {
    const d = typeof date === "number" ? new Date(date) : date;
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  public static maxOfMostFreq(...args: number[]): number {
    if (args.length === 0) {
      return 0;
    }
    const counts: { [key: number]: number } = {};
    let maxCount = 0;
    let maxFreq = 0;
    for (const arg of args) {
      counts[arg] = (counts[arg] || 0) + 1;
      if (counts[arg] > maxCount) {
        maxCount = counts[arg];
        maxFreq = arg;
      } else if (counts[arg] === maxCount) {
        maxFreq = Math.max(maxFreq, arg);
      }
    }
    return maxFreq;
  }

  public static decodeCompactBits(compact: number): bigint {
    const size = compact >> 24;
    let mantissa = BigInt(compact & 0x007fffff);

    // Handle negative sign bit
    if ((compact & 0x00800000) !== 0) {
      mantissa = -mantissa;
    }

    let result: bigint;
    if (size <= 3) {
      result = mantissa;
    } else {
      result = mantissa << BigInt((size - 3) * 8);
    }
    return result;
  }

  public static encodeCompactBits(value: bigint): number {
    let val = value;
    let isNegative = false;

    if (val < 0n) {
      isNegative = true;
      val = -val;
    }

    if (val === 0n) {
      return 0;
    }

    let nSize = 0;
    let nCompact = 0;

    // Calculate nSize (number of bytes needed for the value)
    let tempVal = val;
    while (tempVal > 0n) {
      tempVal >>= 8n;
      nSize++;
    }
    if (nSize === 0 && val > 0n) {
      nSize = 1;
    }

    if (nSize <= 3) {
      nCompact = Number(val);
    } else {
      nCompact = Number(val >> BigInt((nSize - 3) * 8));
    }

    // If the mantissa is 0x800000 or greater, shift right and increment size
    // This ensures the mantissa is always < 0x800000 (2^23)
    if (nCompact >= 0x00800000) {
      nCompact >>= 8;
      nSize++;
    }

    let compact = nCompact | (nSize << 24);
    if (isNegative) {
      compact |= 0x00800000; // Set sign bit for negative numbers
    }
    return compact;
  }

  /**
   * Calculates RIPEMD160(SHA256(input)). This is used in Address calculations.
   * @param {Uint8Array} input - The input data to hash
   * @returns {Uint8Array} - 20-byte RIPEMD160 hash of SHA256(input)
   */
  public static sha256hash160(input: Uint8Array): Uint8Array {
    // First apply SHA256
    const inputBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const sha256Hash = sha256(inputBytes);

    // Then apply RIPEMD160 to the SHA256 result
    const ripemd160Hash = ripemd160(sha256Hash);

    return new Uint8Array(ripemd160Hash);
  }

  /**
   * Converts a BigInteger to a byte array that matches Java's BigInteger.toByteArray() method.

   * @param b The BigInteger to convert
   * @returns A byte array representing the BigInteger in two's-complement form
   */
  public static bigIntToBytes(value: bigint): Uint8Array {
    return UtilsHelper.bigIntToBytes(value);
  }

  public static addAll(buffer1: Uint8Array, buffer2: Uint8Array): Uint8Array {
    const result = allocBuffer(buffer1.length + buffer2.length);
    result.set(buffer1, 0);
    result.set(buffer2, buffer1.length);
    return result;
  }

  public static calculateMerkleRoot(hashes: Sha256Hash[]): Sha256Hash {
    // Implement merkle root calculation
    if (hashes.length === 0) {
      return Sha256Hash.ZERO_HASH;
    }

    let tree = [...hashes];
    while (tree.length > 1) {
      const newTree: Sha256Hash[] = [];
      for (let i = 0; i < tree.length; i += 2) {
        const left = tree[i];
        const right = i + 1 < tree.length ? tree[i + 1] : left;
        const combined = concatBuffers(left.getBytes(), right.getBytes());
        const hash = Sha256Hash.hashTwice(combined);
        newTree.push(Sha256Hash.wrap(hash));
      }
      tree = newTree;
    }
    return tree[0];
  }

  public static copyOf(original: Uint8Array, newLength: number): Uint8Array {
    const newArray = new Uint8Array(newLength);
    newArray.set(original.subarray(0, Math.min(original.length, newLength)));
    return newArray;
  }
}
