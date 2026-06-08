import { Utils } from "../utils/Utils";

/**
 * A variable-length encoded unsigned integer using Satoshi's encoding (a.k.a. "CompactSize").
 */
export class VarInt {
    public readonly value: bigint;
    private readonly originallyEncodedSize: number;

    /**
     * Constructs a new VarInt with the given unsigned long value.
     *
     * @param value the unsigned long value (beware widening conversion of negatives!)
     */
    constructor(value: bigint | number | Uint8Array, offset?: number) {
        // If a Uint8Array value is passed
        let buf: Uint8Array | null = null;
        if (value instanceof Uint8Array) {
            buf = value;
        }
        // Handle if it's a Buffer object (check by constructor name)
        else if (value && (value as any).constructor && (value as any).constructor.name === 'Buffer') {
            buf = new Uint8Array(value as any);
        }

        if (buf) {
            // Constructor with buffer and offset
            if (offset === undefined) {
                throw new Error("Offset must be provided when constructing from buffer");
            }

            // Debug logs helpful when diagnosing parsing issues
            // console.log(`VarInt.constructor: buf.length=${buf.length}, offset=${offset}, buf[${offset}]=${buf[offset].toString(16)}`);
            const first = 0xFF & buf[offset];
            if (first < 253) {
                this.value = BigInt(first);
                this.originallyEncodedSize = 1; // 1 data byte (8 bits)
            } else if (first === 253) {
                this.value = BigInt(0xFF & buf[offset + 1]) | (BigInt(0xFF & buf[offset + 2]) << 8n);
                this.originallyEncodedSize = 3; // 1 marker + 2 data bytes (16 bits)
            } else if (first === 254) {
                this.value = BigInt(Utils.readUint32(buf, offset + 1));
                this.originallyEncodedSize = 5; // 1 marker + 4 data bytes (32 bits)
            } else {
                this.value = Utils.readUint64(buf, offset + 1);
                this.originallyEncodedSize = 9; // 1 marker + 8 data bytes (64 bits)
            }
        } else {
            // Constructor with numeric/bigint value
            this.value = typeof value === 'number' ? BigInt(value) : (value as bigint);
            this.originallyEncodedSize = this.getSizeInBytes();
        }
    }

    /**
     * Constructs a new VarInt with the value parsed from the specified offset of the given buffer.
     *
     * @param buf the buffer containing the value
     * @param offset the offset of the value
     */
    public static fromBuffer(buf: Uint8Array, offset: number): VarInt {
        return new VarInt(buf, offset);
    }

    /**
     * Returns the original number of bytes used to encode the value if it was
     * deserialized from a byte array, or the minimum encoded size if it was not.
     */
    public getOriginalSizeInBytes(): number {
        return this.originallyEncodedSize;
    }

    /**
     * Returns the minimum encoded size of the value.
     */
    public getSizeInBytes(): number {
        return VarInt.sizeOf(this.value);
    }

    /**
     * Returns the minimum encoded size of the given unsigned long value.
     *
     * @param value the unsigned long value (beware widening conversion of negatives!)
     */
    public static sizeOf(value: bigint | number): number {
        const val = typeof value === 'number' ? BigInt(value) : value;
        // if negative, it's actually a very large unsigned long value
        if (val < 0n) return 9; // 1 marker + 8 data bytes
        if (val < 253n) return 1; // 1 data byte
        if (val <= 0xFFFFn) return 3; // 1 marker + 2 data bytes
        if (val <= 0xFFFFFFFFn) return 5; // 1 marker + 4 data bytes
        return 9; // 1 marker + 8 data bytes
    }

    /**
     * Encodes the value into its minimal representation.
     *
     * @return the minimal encoded bytes of the value
     */
    public encode(): Uint8Array {
        const size = VarInt.sizeOf(this.value);
        let buf: Uint8Array;

        switch (size) {
            case 1:
                return new Uint8Array([Number(this.value)]);
            case 3:
                return new Uint8Array([253, Number(this.value & 0xFFn), Number((this.value >> 8n) & 0xFFn)]);
            case 5:
                buf = new Uint8Array(5);
                buf[0] = 254;
                Utils.uint32ToByteArrayLE(Number(this.value), buf, 1);
                return buf;
            default:
                buf = new Uint8Array(9);
                buf[0] = 255;
                Utils.uint64ToByteArrayLE(this.value, buf, 1);
                return buf;
        }
    }
}
