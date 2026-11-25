/**
 * Minimal Protocol Buffers (proto2) wire-format codec.
 *
 * This is a small, dependency-free implementation of the protobuf wire format
 * used to read and write the legacy `.wallet` file format (see `wallet.proto`
 * in the Java blockchain codebase, `WalletProtobufSerializer.java`).
 *
 * Only the wire types used by the wallet schema are supported: varint (0),
 * fixed64 (1), length-delimited (2) and fixed32 (5).
 */

/** Protobuf wire types. */
export enum WireType {
  VARINT = 0,
  FIXED64 = 1,
  LENGTH_DELIMITED = 2,
  START_GROUP = 3,
  END_GROUP = 4,
  FIXED32 = 5,
}

/**
 * A single decoded field. Exactly one of `varint`, `bytes`, `fixed32` or
 * `fixed64` is populated, depending on the wire type.
 */
export interface ProtoField {
  field: number;
  wireType: WireType;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed32?: number;
  fixed64?: bigint;
}

function readVarint(bytes: Uint8Array, pos: number): { value: bigint; newPos: number } {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (pos >= bytes.length) {
      throw new Error("Truncated protobuf varint");
    }
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      break;
    }
    shift += 7n;
  }
  return { value: result, newPos: pos };
}

/**
 * Decodes a protobuf message into a list of (field, wire type, value) tuples.
 * Unknown fields are retained but ignored by the typed accessors below.
 */
export function decodeProto(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const tagRead = readVarint(bytes, pos);
    pos = tagRead.newPos;
    const tag = tagRead.value;
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n) as WireType;
    if (field === 0) {
      throw new Error("Invalid protobuf field number 0");
    }
    const fieldEntry: ProtoField = { field, wireType };
    switch (wireType) {
      case WireType.VARINT: {
        const v = readVarint(bytes, pos);
        fieldEntry.varint = v.value;
        pos = v.newPos;
        break;
      }
      case WireType.LENGTH_DELIMITED: {
        const lenRead = readVarint(bytes, pos);
        pos = lenRead.newPos;
        const len = Number(lenRead.value);
        if (len < 0 || pos + len > bytes.length) {
          throw new Error("Invalid protobuf length-delimited field");
        }
        fieldEntry.bytes = bytes.slice(pos, pos + len);
        pos += len;
        break;
      }
      case WireType.FIXED32: {
        if (pos + 4 > bytes.length) {
          throw new Error("Truncated protobuf fixed32 field");
        }
        fieldEntry.fixed32 = (
          (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0
        );
        pos += 4;
        break;
      }
      case WireType.FIXED64: {
        if (pos + 8 > bytes.length) {
          throw new Error("Truncated protobuf fixed64 field");
        }
        let value = 0n;
        for (let i = 0; i < 8; i++) {
          value |= BigInt(bytes[pos + i]) << BigInt(i * 8);
        }
        fieldEntry.fixed64 = value;
        pos += 8;
        break;
      }
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType} for field ${field}`);
    }
    fields.push(fieldEntry);
  }
  return fields;
}

function entries(fields: ProtoField[], field: number): ProtoField[] {
  return fields.filter((f) => f.field === field);
}

export function firstVarint(fields: ProtoField[], field: number): bigint | undefined {
  const entry = entries(fields, field)[0];
  return entry && entry.wireType === WireType.VARINT ? entry.varint : undefined;
}

export function allVarints(fields: ProtoField[], field: number): bigint[] {
  return entries(fields, field)
    .filter((f) => f.wireType === WireType.VARINT && f.varint !== undefined)
    .map((f) => f.varint!);
}

export function firstBytes(fields: ProtoField[], field: number): Uint8Array | undefined {
  const entry = entries(fields, field)[0];
  return entry && entry.wireType === WireType.LENGTH_DELIMITED ? entry.bytes : undefined;
}

export function firstString(fields: ProtoField[], field: number): string | undefined {
  const bytes = firstBytes(fields, field);
  return bytes !== undefined ? new TextDecoder().decode(bytes) : undefined;
}

export function firstMessage(fields: ProtoField[], field: number): ProtoField[] | undefined {
  const bytes = firstBytes(fields, field);
  return bytes !== undefined ? decodeProto(bytes) : undefined;
}

export function repeatedBytes(fields: ProtoField[], field: number): Uint8Array[] {
  return entries(fields, field)
    .filter((f) => f.wireType === WireType.LENGTH_DELIMITED && f.bytes !== undefined)
    .map((f) => f.bytes!);
}

export function repeatedMessages(fields: ProtoField[], field: number): ProtoField[][] {
  return repeatedBytes(fields, field).map((b) => decodeProto(b));
}

function encodeVarint(value: bigint | number): Uint8Array {
  let v = typeof value === 'number' ? BigInt(value) : value;
  const out: number[] = [];
  while (true) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return Uint8Array.from(out);
}

function encodeTag(field: number, wireType: WireType): Uint8Array {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wireType));
}

export function encodeVarintField(field: number, value: bigint | number): Uint8Array {
  return concat(encodeTag(field, WireType.VARINT), encodeVarint(value));
}

export function encodeLengthDelimitedField(field: number, data: Uint8Array): Uint8Array {
  return concat(encodeTag(field, WireType.LENGTH_DELIMITED), encodeVarint(data.length), data);
}

export function encodeStringField(field: number, value: string): Uint8Array {
  return encodeLengthDelimitedField(field, new TextEncoder().encode(value));
}

export function encodeMessageField(field: number, message: Uint8Array): Uint8Array {
  return encodeLengthDelimitedField(field, message);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
