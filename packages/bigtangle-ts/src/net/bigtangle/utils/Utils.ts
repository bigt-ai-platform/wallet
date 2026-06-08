import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { VerificationException } from "../exception/VerificationException";
import * as tools from "uint8array-tools";

import { Buffer } from "buffer";
import { ContractEventInfo } from "../core/ContractEventInfo";
import { Token } from "../core/Token";
import { TokenKeyValues } from "../core/TokenKeyValues";
import { BaseEncoding } from "./BaseEncoding";

import { UnsafeByteArrayOutputStream } from "../core/UnsafeByteArrayOutputStream";
import { DataInputStream } from "../utils/DataInputStream";

/**
 * A collection of various utility methods that are helpful for working with the
 * Bitcoin protocol.
 */
export class Utils {
  public static readonly BITCOIN_SIGNED_MESSAGE_HEADER =
    "Bitcoin Signed Message:\n";
  public static readonly BITCOIN_SIGNED_MESSAGE_HEADER_BYTES =
    new TextEncoder().encode(Utils.BITCOIN_SIGNED_MESSAGE_HEADER);

  public static readonly HEX = BaseEncoding.base16().lowerCase();


    /**
     * Converts a BigInt to a byte array that matches Java's BigInteger.toByteArray() method.
     * This method returns a byte array containing the two's-complement representation of this BigInt.
     * The byte array will be in big-endian byte-order: the most significant byte is in the zeroth element.
     * The array will contain the minimum number of bytes required to represent this BigInt,
     * including at least one sign bit, which is (ceil((this.bitLength() + 1)/8)).
     *
     * @param b The BigInt to convert
     * @returns A byte array representing the BigInt in two's-complement form
     */
    public static bigIntToBytes(b: bigint | number): Uint8Array {
        if (b === null || b === undefined) {
            return new Uint8Array(0);
        }

        // Convert to bigint if needed
        let value = typeof b === 'number' ? BigInt(b) : b;

        // Handle zero case
        if (value === 0n) {
            return new Uint8Array([0]);
        }

        // Get the absolute value as bytes
        const isNegative = value < 0n;
        let absValue = isNegative ? -value : value;

        // Convert to byte array by repeatedly dividing by 256
        const bytes: number[] = [];
        
        while (absValue > 0n) {
            bytes.push(Number(absValue % 256n));
            absValue = absValue / 256n;
        }
        
        // Reverse to get big-endian format (most significant byte first)
        bytes.reverse();

        // For positive numbers, we might need to add a zero byte at the beginning
        // if the most significant bit is set (to ensure it's interpreted as positive)
        if (!isNegative && bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
            bytes.unshift(0);
        }

        // For negative numbers, we need to compute the two's complement
        if (isNegative) {
            // Ensure we have at least one byte
            if (bytes.length === 0) {
                bytes.push(0);
            }
            
            // Compute two's complement: invert all bits and add 1
            // Invert all bits
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = ~bytes[i] & 0xFF;
            }
            
            // Add 1 to complete two's complement
            let carry = 1;
            for (let i = bytes.length - 1; i >= 0 && carry > 0; i--) {
                const sum = bytes[i] + carry;
                bytes[i] = sum & 0xFF;
                carry = sum > 0xFF ? 1 : 0;
            }
            
            // If we still have a carry, we need to expand the array
            if (carry > 0) {
                bytes.unshift(1);
            }
            
            // Now ensure the most significant bit is 1 for negative numbers
            if ((bytes[0] & 0x80) === 0) {
                // We need to add a leading byte with all bits set to 1
                bytes.unshift(0xFF);
            }
        }

        return new Uint8Array(bytes);
    }


  /**
   * Converts a BigInt to a fixed-size byte array.
   *
   * @param value The BigInt to convert
   * @param length The fixed length of the output array
   * @returns A byte array of the specified length representing the BigInt
   */
  public static bigIntToBytesFixed(
    value: bigint | number,
    length: number
  ): Uint8Array {
    const bytes = Utils.bigIntToBytes(value);
    const result = new Uint8Array(length);

    // Copy bytes to the end of the fixed-size array
    const copyStart = Math.max(0, length - bytes.length);
    const bytesStart = Math.max(0, bytes.length - length);

    for (let i = 0; i < Math.min(bytes.length, length); i++) {
      result[copyStart + i] = bytes[bytesStart + i];
    }

    // If the number is negative, fill the leading bytes with 0xFF
    if (typeof value === 'bigint' ? value < 0n : value < 0) {
      for (let i = 0; i < copyStart; i++) {
        result[i] = 0xff;
      }
    }

    return result;
  }

  /**
   * Converts a byte array to a BigInt, matching Java's BigInteger(byte[]) constructor.
   * This method interprets the byte array as a two's-complement representation of a BigInt.
   * The first byte's most significant bit indicates the sign (1 for negative, 0 for positive).
   *
   * @param bytes The byte array to convert
   * @returns A BigInt representing the value in the byte array
   */
  public static bytesToBigInt(bytes: Uint8Array): bigint {
    if (bytes.length === 0) {
      return 0n;
    }

    // Check if the number is negative (MSB of first byte is 1)
    const isNegative = (bytes[0] & 0x80) !== 0;

    if (!isNegative) {
      // Positive number - straightforward conversion
      // Convert each byte to its contribution to the total value
      let result = 0n;
      for (let i = 0; i < bytes.length; i++) {
        result = result * 256n + BigInt(bytes[i]);
      }
      return result;
    } else {
      // Negative number - need to convert from two's complement
      // First, invert all bits
      const invertedBytes = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        invertedBytes[i] = ~bytes[i] & 0xff;
      }

      // Then add 1 to get the absolute value
      let carry = 1;
      for (let i = invertedBytes.length - 1; i >= 0 && carry > 0; i--) {
        const sum = invertedBytes[i] + carry;
        invertedBytes[i] = sum & 0xff;
        carry = sum > 0xff ? 1 : 0;
      }

      // Convert to BigInt and negate
      let absValue = 0n;
      for (let i = 0; i < invertedBytes.length; i++) {
        absValue = absValue * 256n + BigInt(invertedBytes[i]);
      }
      return -absValue;
    }
  }

  public static uint32ToByteArrayBE(
    val: number,
    out: Uint8Array,
    offset: number
  ): void {
    tools.writeUInt32(out, offset, val, "BE");
  }

  public static uint32ToByteArrayLE(
    val: number,
    out: Uint8Array,
    offset: number
  ): void {
    tools.writeUInt32(out, offset, val, "LE");
  }

  public static uint64ToByteArrayLE(
    val: bigint | number,
    out: Uint8Array,
    offset: number
  ): void {
    const bytes = Utils.bigIntToBytesFixed(val, 8);
    for (let i = 0; i < 8; i++) {
      out[offset + i] = bytes[7 - i]; // Reverse for LE
    }
  }

  public static bytesToByteStream(b: Uint8Array, stream: any): void {
    stream.write(b);
  }

  public static uint32ToByteStreamLE(val: number, stream: any): void {
    stream.write(val & 0xff);
    stream.write((val >>> 8) & 0xff);
    stream.write((val >>> 16) & 0xff);
    stream.write((val >>> 24) & 0xff);
  }

  public static writeVarIntLE(value: number, stream: any): void {
    while (value >= 0x80) {
      stream.write((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    stream.write(value & 0x7f);
  }

  public static isLessThanUnsigned(n1: number, n2: number): boolean {
    return n1 < n2 !== (n1 < 0 !== n2 < 0);
  }

  public static isLessThanOrEqualToUnsigned(n1: number, n2: number): boolean {
    return n1 <= n2 !== (n1 < 0 !== n2 < 0);
  }

  public static reverseBytes(bytes: Uint8Array): Uint8Array {
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      buf[i] = bytes[bytes.length - 1 - i];
    }
    return buf;
  }

  public static reverseDwordBytes(
    bytes: Uint8Array,
    trimLength: number
  ): Uint8Array {
    if (bytes.length % 4 !== 0)
      throw new Error("bytes.length must be divisible by 4");
    if (trimLength >= 0 && trimLength % 4 !== 0)
      throw new Error("trimLength must be divisible by 4 or negative");

    const rev = new Uint8Array(
      trimLength >= 0 && bytes.length > trimLength ? trimLength : bytes.length
    );

    for (let i = 0; i < rev.length; i += 4) {
      rev[i] = bytes[i + 3];
      rev[i + 1] = bytes[i + 2];
      rev[i + 2] = bytes[i + 1];
      rev[i + 3] = bytes[i];
    }
    return rev;
  }

  public static readUint32(bytes: Uint8Array, offset: number): number {
    if (offset + 4 > bytes.length) {
      throw new Error(
        "Attempt to read 4 bytes from position " +
          offset +
          " with only " +
          bytes.length +
          " bytes available"
      );
    }
    const result = tools.readUInt32(bytes, offset, "LE");
 
    return result;
  }

  public static readInt64(bytes: Uint8Array, offset: number): bigint {
    const value = tools.readUInt64(bytes, offset, "LE");
    // Convert to signed BigInt
    if (value >= 0x8000000000000000n) {
      return value - 0x10000000000000000n;
    }
    return value;
  }

  public static readUint64(bytes: Uint8Array, offset: number): bigint {
    return tools.readUInt64(bytes, offset, "LE");
  }

  public static readUint32BE(bytes: Uint8Array, offset: number): number {
    return tools.readUInt32(bytes, offset, "BE");
  }

  public static readNBytesString(dis: DataInputStream): string | null {
    const hasValue = dis.readBoolean();
    if (hasValue) {
      const length = dis.readInt();
      const buf = dis.readBytes(length);
      return new TextDecoder("utf-8").decode(buf);
    } else {
      return null;
    }
  }

  public static readNBytes(dis: DataInputStream): Uint8Array | null {
    const hasValue = dis.readBoolean();
    if (hasValue) {
      const length = dis.readInt();
      const message = dis.readBytes(length);
      return message;
    } else {
      return null;
    }
  }

  public static writeNBytesString(
    dos: UnsafeByteArrayOutputStream,
    message: string | null
  ): void {
    dos.writeBoolean(message !== null);
    if (message !== null) {
      const bytes = new TextEncoder().encode(message);
      dos.writeInt(bytes.length);
      dos.write(new Uint8Array(bytes));
    }
  }

  public static writeLong(
    dos: UnsafeByteArrayOutputStream,
    message: number | null
  ): void {
    dos.writeBoolean(message !== null);
    if (message !== null) {
      dos.writeLong(message);
    }
  }

  public static readLong(dis: DataInputStream): number | null {
    const hasValue = dis.readBoolean();
    if (hasValue) {
      return dis.readLong();
    } else {
      return null;
    }
  }

  public static writeNBytes(
    dos: UnsafeByteArrayOutputStream,
    message: Uint8Array | null
  ): void {
    dos.writeBoolean(message !== null);
    if (message !== null) {
      dos.writeInt(message.length);
      dos.write(new Uint8Array(message));
    }
  }

  public static readUint16BE(bytes: Uint8Array, offset: number): number {
    return tools.readUInt16(bytes, offset, "BE");
  }

  public static sha256hash160(input: Uint8Array): Uint8Array {
    const sha256Result = sha256(input);
    return ripemd160(sha256Result);
  }

  public static decodeMPI(mpi: Uint8Array, hasLength: boolean): bigint {
    let buf: Uint8Array;
    if (hasLength) {
      const length = Utils.readUint32BE(mpi, 0);
      buf = mpi.subarray(4, 4 + length);
    } else {
      buf = mpi;
    }
    if (buf.length === 0) {
      return 0n;
    }
    const isNegative = (buf[0] & 0x80) === 0x80;
    if (isNegative) {
      buf[0] &= 0x7f;
    }
    const hex = Utils.HEX.encode(buf);
    let result = BigInt(`0x${hex}`);
    return isNegative ? -result : result;
  }

  public static encodeMPI(
    value: bigint | number,
    includeLength: boolean
  ): Uint8Array {
    let v = typeof value === 'number' ? BigInt(value) : value;
    
    if (v === 0n) {
      if (!includeLength) {
        return new Uint8Array(0);
      } else {
        return new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      }
    }
    const isNegative = v < 0n;
    const absValue = isNegative ? -v : v;

    // Convert bigint to bytes - get bytes in big-endian format
    let array: Uint8Array;
    if (absValue === 0n) {
      array = new Uint8Array([0]);
    } else {
      // Convert to hex string and then to bytes
      let hex = absValue.toString(16);
      if (hex.length % 2 !== 0) {
        hex = '0' + hex; // Ensure even length
      }
      array = new Uint8Array(hex.length / 2);
      for (let i = 0; i < array.length; i++) {
        array[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
    }

    // Ensure the highest bit is not set if positive, or is set if negative (for MPI format)
    let length = array.length;
    if (array.length > 0 && (array[0] & 0x80) === 0x80) {
      length++;
    }

    let resultBytes: Uint8Array;
    if (length !== array.length) {
      resultBytes = new Uint8Array(length);
      resultBytes.set(array, 1);
    } else {
      resultBytes = array;
    }

    if (isNegative) {
      resultBytes[0] |= 0x80;
    }

    
    if (includeLength) {
      const finalResult = new Uint8Array(resultBytes.length + 4);
      Utils.uint32ToByteArrayBE(resultBytes.length, finalResult, 0);
      finalResult.set(resultBytes, 4);
      return finalResult;
    } else {
      return resultBytes;
    }
  }

  public static decodeCompactBits(compact: number): bigint {
    const size = (compact >>> 24) & 0xff;
    const b = new Uint8Array(4);
    b[0] = (compact >>> 16) & 0xff;
    b[1] = (compact >>> 8) & 0xff;
    b[2] = compact & 0xff;
    b[3] = 0;

    // Convert the first 3 bytes to bigint
    let hex = Utils.HEX.encode(b.slice(0, 3));
    let mantissa = BigInt(`0x${hex}`);

    if ((compact & 0x00800000) !== 0) {
      mantissa = -mantissa;
    }

    if (size <= 3) {
      return mantissa >> BigInt(8 * (3 - size));
    } else {
      return mantissa << BigInt(8 * (size - 3));
    }
  }

  public static encodeCompactBits(value: bigint | number): number {
    let v = typeof value === 'number' ? BigInt(value) : value;
    if (v === 0n) {
      return 0;
    }

    const absValue = v < 0n ? -v : v;
    let hex = absValue.toString(16);
    if (hex.length % 2 !== 0) {
      hex = "0" + hex;
    }
    let size = hex.length / 2;

    let mantissaHex;
    if (size <= 3) {
      mantissaHex = hex;
      while (mantissaHex.length < 6) {
        mantissaHex = "00" + mantissaHex;
      }
    } else {
      mantissaHex = hex.substring(0, 6);
    }

    let mantissa = parseInt(mantissaHex, 16);

    if (mantissa & 0x800000) {
      mantissa >>= 8;
      size++;
    }

    let compact = (size << 24) | mantissa;
    if (v < 0n) {
      compact |= 0x800000;
    }
    return compact;
  }

  public static mockTime: Date | null = null;

  public static rollMockClock(seconds: number): Date {
    return Utils.rollMockClockMillis(seconds * 1000);
  }

  public static rollMockClockMillis(millis: number): Date {
    if (Utils.mockTime === null) {
      throw new Error("You need to use setMockClock() first.");
    }
    Utils.mockTime = new Date(Utils.mockTime.getTime() + millis);
    return Utils.mockTime;
  }

  public static unsetMockClock(): void {
    Utils.mockTime = null;
  }

  public static setMockClock(): void {
    Utils.mockTime = new Date();
  }

  public static setMockClockWithSeconds(mockClockSeconds: number): void {
    Utils.mockTime = new Date(mockClockSeconds * 1000);
  }

  public static now(): Date {
    return Utils.mockTime !== null ? Utils.mockTime : new Date();
  }

  public static currentTimeMillis(): number {
    return Utils.mockTime !== null ? Utils.mockTime.getTime() : Date.now();
  }

  public static currentTimeSeconds(): number {
    return Math.floor(Utils.currentTimeMillis() / 1000);
  }

  public static dateTimeFormat(dateTime: Date | number): string {
    const date = typeof dateTime === "number" ? new Date(dateTime) : dateTime;
    return date.toISOString().replace(/\.\d{3}Z$/, "Z"); // Simple ISO 8601 format
  }

  public static join(items: Iterable<any>): string {
    return Array.from(items).join(" ");
  }

  public static copyOf(input: Uint8Array, length: number): Uint8Array {
    const out = new Uint8Array(length);
    out.set(input.subarray(0, Math.min(length, input.length)), 0);
    return out;
  }

  public static appendByte(bytes: Uint8Array, b: number): Uint8Array {
    const result = new Uint8Array(bytes.length + 1);
    result.set(bytes, 0);
    result[bytes.length] = b;
    return result;
  }

  public static toString(bytes: Uint8Array, charsetName: string): string {
    return new TextDecoder(charsetName).decode(bytes);
  }

  public static isWindows(): boolean {
    return false; // Node.js/browser environment, not Windows
  }

  public static checkBitLE(data: Uint8Array, index: number): boolean {
    return ((data[index >>> 3] || 0) & (1 << (7 & index))) !== 0;
  }

  public static setBitLE(data: Uint8Array, index: number): void {
    data[index >>> 3] |= 1 << (7 & index);
  }

  public static isBlank(cs: string | null | undefined): boolean {
    if (cs === null || cs === undefined || cs.length === 0) {
      return true;
    }
    for (let i = 0; i < cs.length; i++) {
      if (!/\s/.test(cs.charAt(i))) {
        return false;
      }
    }
    return false;
  }

  public static strLength(cs: string | null | undefined): number {
    return cs === null || cs === undefined ? 0 : cs.length;
  }

  public static addAll(array1: Uint8Array, array2: Uint8Array): Uint8Array {
    const joinedArray = new Uint8Array(array1.length + array2.length);
    joinedArray.set(array1, 0);
    joinedArray.set(array2, array1.length);
    return joinedArray;
  }

  public static clone(array: Uint8Array | null): Uint8Array | null {
    if (array === null) {
      return null;
    }
    return new Uint8Array(array);
  }

  public checkContractBase(
    contractEventInfo: ContractEventInfo,
    contract: Token
  ): void {
    const amountStr = this.findContractValue(
      contract.getTokenKeyValues(),
      "amount"
    );
    if (amountStr !== null) {
      const amount = BigInt(amountStr);
      if (
        contractEventInfo.getOfferValue() !== null &&
        BigInt(contractEventInfo.getOfferValue()!) % BigInt(amount) !== 0n
      ) {
        throw new VerificationException(
          `only module base amount is allowed ${contractEventInfo.getOfferValue()} % ${amount}`
        );
      }
    }
    const tokenid = this.findContractValue(
      contract.getTokenKeyValues(),
      "token"
    );
    if (
      tokenid !== null &&
      contractEventInfo.getOfferTokenid() !== null &&
      tokenid !== contractEventInfo.getOfferTokenid()
    ) {
      throw new VerificationException(
        "ContractEventInfo tokenidis not correct  "
      );
    }
  }

  public findContractValue(
    t: TokenKeyValues | null,
    key: string
  ): string | null {
    if (t === null || t.getKeyvalues() === null) {
      return null;
    }
    for (const kv of t.getKeyvalues()!) {
      if (kv.getKey() === key) {
        return kv.getValue();
      }
    }
    return null;
  }

  static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Compares two Buffers for byte-wise equality.
   */
  public static bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  public static hashCode(data: Uint8Array): number {
    let hash = 0;
    for (const element of data) {
      const char = element;
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }
}
