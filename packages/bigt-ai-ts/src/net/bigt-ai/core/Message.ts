/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2011 Google Inc.
 * Copyright 2014 Andreas Schildbach
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ProtocolException } from '../exception/ProtocolException';
import { NetworkParameters } from '../params/NetworkParameters';
import { ProtocolVersion } from '../params/ProtocolVersion';
import { VarInt } from './VarInt';
import { Utils } from './Utils';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { Sha256Hash } from './Sha256Hash';
import { MessageSerializer } from './MessageSerializer';

// Importing necessary types and functions
import { Preconditions } from '../utils/Preconditions';

;

const { checkState } = Preconditions;

// Define OutputStream interface to match UnsafeByteArrayOutputStream
interface OutputStream {
    write(b: number | Buffer): void;
    writeBytes(b: Uint8Array, off: number, len: number): void;
}

/**
 * <p>A Message is a data structure that can be serialized/deserialized using the Bitcoin serialization format.
 * Specific types of messages that are used both in the block chain, and on the wire, are derived from this
 * class.</p>
 *
 * <p>Instances of this class are not safe for use by multiple threads.</p>
 */
export abstract class Message {
    public static readonly MAX_SIZE: number = 0x02000000; // 32MB

    public static readonly UNKNOWN_LENGTH: number = Number.MIN_SAFE_INTEGER;

    // The offset is how many bytes into the provided byte array this message payload starts at.
    protected offset: number = 0;
    // The cursor keeps track of where we are in the byte array as we parse it.
    // Note that it's relative to the start of the array NOT the start of the message payload.
    protected cursor: number = 0;

    protected length: number = Message.UNKNOWN_LENGTH;

    // The raw message payload bytes themselves.
    protected payload: Uint8Array | null = null;

    protected recached: boolean = false;
    protected serializer: MessageSerializer<NetworkParameters> | null = null;

    protected protocolVersion: number = 0;

    protected params: NetworkParameters | null = null;

    public getLength(): number {
        return this.length;
    }


    public constructor(params: NetworkParameters) {
        this.params = params;
        this.serializer = params.getDefaultSerializer();
    }


    protected setValues3(params: NetworkParameters, payload: Uint8Array, offset: number): void {
        this.setValues5(params, payload, offset, params.getDefaultSerializer(), Message.UNKNOWN_LENGTH);
    }

    protected setValues5(params: NetworkParameters, payload: Uint8Array, offset: number, serializer: MessageSerializer<NetworkParameters>, length: number): void {
        this.serializer = serializer;
        this.protocolVersion = params.getProtocolVersionNum(ProtocolVersion.CURRENT);
        this.params = params;
        this.payload = payload;
        this.cursor = this.offset = offset;
        this.length = length;
        
        // Log the first few bytes of the payload for debugging
        if (payload && payload.length > 0) {
            let bytesStr = "";
            const end = Math.min(payload.length, 20);
            for (let i = 0; i < end; i++) {
                bytesStr += payload[i].toString(16).padStart(2, '0') + " ";
            }
        //    console.log(`Message.setValues5: payload[0..${end-1}]=${bytesStr}`);
        //    console.log(`Message.setValues5: payload.length=${payload.length}`);
        }

        this.parse();

        if (this.length === Message.UNKNOWN_LENGTH) {
            checkState(false, `Length field has not been set in constructor for ${this.constructor.name} after parse.`);
        }

        if (this.serializer && !this.serializer.isParseRetainMode()) {
            this.payload = null;
        }
    }


    // These methods handle the serialization/deserialization using the custom Bitcoin protocol.

    protected abstract parse(): void;

    /**
     * <p>To be called before any change of internal values including any setters. This ensures any cached byte array is
     * removed.<p/>
     * <p>Child messages of this object(e.g. Transactions belonging to a Block) will not have their internal byte caches
     * invalidated unless they are also modified internally.</p>
     */
    protected unCache(): void {
        this.payload = null;
        this.recached = false;
    }

    protected adjustLength(newArraySize: number, adjustment: number): void {
        if (this.length === Message.UNKNOWN_LENGTH)
            return;
        // Our own length is now unknown if we have an unknown length adjustment.
        if (adjustment === Message.UNKNOWN_LENGTH) {
            this.length = Message.UNKNOWN_LENGTH;
            return;
        }
        this.length += adjustment;
        // Check if we will need more bytes to encode the length prefix.
        if (newArraySize === 1)
            this.length++;  // The assumption here is we never call adjustLength with the same arraySize as before.
        else if (newArraySize !== 0)
            this.length += VarInt.sizeOf(newArraySize) - VarInt.sizeOf(newArraySize - 1);
    }

    /**
     * used for unit testing
     */
    public isCached(): boolean {
        return this.payload !== null;
    }

    public isRecached(): boolean {
        return this.recached;
    }

    /**
     * Serialize this message to a byte array that conforms to the bitcoin wire protocol.
     * <br/>
     * This method may return the original byte array used to construct this message if the
     * following conditions are met:
     * <ol>
     * <li>1) The message was parsed from a byte array with parseRetain = true</li>
     * <li>2) The message has not been modified</li>
     * <li>3) The array had an offset of 0 and no surplus bytes</li>
     * </ol>
     *
     * If condition 3 is not met then an copy of the relevant portion of the array will be returned.
     * Otherwise a full serialize will occur. For this reason you should only use this API if you can guarantee you
     * will treat the resulting array as read only.
     *
     * @return a byte array owned by this object, do NOT mutate it.
     */
    public bitcoinSerialize(): Uint8Array;
    public bitcoinSerialize(stream: OutputStream): void;
    public bitcoinSerialize(stream?: OutputStream): Uint8Array | void {
        if (stream) {
            // Serialize this message to the provided OutputStream using the bitcoin wire format.
            // 1st check for cached bytes.
            if (this.payload !== null && this.length !== Message.UNKNOWN_LENGTH) {
                const buffer = new Uint8Array(this.payload);
                stream.writeBytes(buffer, this.offset, this.length);
                return;
            }

            this.bitcoinSerializeToStream(stream);
        } else {
            // Returns a copy of the array returned by {@link Message#unsafeBitcoinSerialize()}, which is safe to mutate.
            // If you need extra performance and can guarantee you won't write to the array, you can use the unsafe version.
            const bytes = this.unsafeBitcoinSerialize();
            const copy = new Uint8Array(bytes.length);
            copy.set(bytes);
            return copy;
        }
    }

    /**
     * Serialize this message to a byte array that conforms to the bitcoin wire protocol.
     * <br/>
     * This method may return the original byte array used to construct this message if the
     * following conditions are met:
     * <ol>
     * <li>1) The message was parsed from a byte array with parseRetain = true</li>
     * <li>2) The message has not been modified</li>
     * <li>3) The array had an offset of 0 and no surplus bytes</li>
     * </ol>
     *
     * If condition 3 is not met then an copy of the relevant portion of the array will be returned.
     * Otherwise a full serialize will occur. For this reason you should only use this API if you can guarantee you
     * will treat the resulting array as read only.
     *
     * @return a byte array owned by this object, do NOT mutate it.
     */
    public unsafeBitcoinSerialize(): Uint8Array {
        // 1st attempt to use a cached array.
        if (this.payload !== null) {
            if (this.offset === 0 && this.length === this.payload.length) {
                // Cached byte array is the entire message with no extras so we can return as is and avoid an array
                // copy.
                return this.payload;
            }

            const buf = new Uint8Array(this.length);
            buf.set(this.payload.subarray(this.offset, this.offset + this.length));
            return buf;
        }

        // No cached array available so serialize parts by stream.
        const stream = new UnsafeByteArrayOutputStream(this.length < 32 ? 32 : this.length + 32); 
            this.bitcoinSerializeToStream(stream); 

        // Prefer to avoid caching truncated or partial buffers. Only recache into this.payload
        // when the serialized buffer length matches the expected this.length (if known).
       
        if (this.serializer && this.serializer.isParseRetainMode()) {
           
                // Safe to recache: the produced byte array matches expected length.
                this.payload =  stream.toByteArray();;
                this.cursor = this.cursor - this.offset;
                this.offset = 0;
                this.recached = true;
                this.length = this.payload.length;
                return this.payload;
   
        }

        // Record length. If this Message wasn't parsed from a byte stream it won't have length field
        // set (except for static length message types).  Setting it makes future streaming more efficient
        // because we can preallocate the ByteArrayOutputStream buffer and avoid resizing.
         const buf = stream.toByteArray();
        this.length = buf.length;

        //  console.log(`UnsafeByteArrayOutputStream.toByteArray: cursor=${this.cursor }, offset =${ this.offset}, buf.length=${ buf.length}`);
        return buf;
    }

    /**
     * Serializes this message to the provided stream. If you just want the raw bytes use bitcoinSerialize().
     */
    protected bitcoinSerializeToStream(stream: OutputStream): void {
        console.error(`Error: ${this.constructor.name} class has not implemented bitcoinSerializeToStream method.  Generating message with no payload`);
    }

    /**
     * This method is a NOP for all classes except Block and Transaction.  It is only declared in Message
     * so BitcoinSerializer can avoid 2 instanceof checks + a casting.
     */
    public getHash(): Sha256Hash {
        throw new Error("Unsupported operation");
    }

    /**
     * This returns a correct value by parsing the message.
     */
    public getMessageSize(): number {
        if (this.length === Message.UNKNOWN_LENGTH) {
            checkState(false, `Length field has not been set in ${this.constructor.name}.`);
        }
        return this.length;
    }

    protected readUint32(): number {
        try {
            if (!this.payload) {
                throw new ProtocolException("Payload is null");
            }
            const u = Utils.readUint32(new Uint8Array(this.payload), this.cursor);
            this.cursor += 4;
            return u;
        } catch (e) {
            if (e instanceof ArrayIndexOutOfBoundsException) {
                throw new ProtocolException(e.message || "Array index out of bounds");
            }
            throw e;
        }
    }

    protected readInt64(): bigint {
        try {
            if (!this.payload) {
                throw new ProtocolException("Payload is null");
            }
            const u = Utils.readInt64(new Uint8Array(this.payload), this.cursor);
            this.cursor += 8;
            // Utils.readInt64 returns a big-integer BigInteger object. Convert to native bigint.
            // Use string conversion to avoid precision issues and rely on big-integer to produce exact value.
            return BigInt(u.toString());
        } catch (e) {
            if (e instanceof ArrayIndexOutOfBoundsException) {
                throw new ProtocolException(e.message || "Array index out of bounds");
            }
            throw e;
        }
    }

    protected readUint64(): bigint {
        // Java does not have an unsigned 64 bit type. So scrape it off the wire then flip.
        if (!this.payload) {
            throw new ProtocolException("Payload is null");
        }
        // Use readInt64 and convert to unsigned if needed
    const value = Utils.readInt64(new Uint8Array(this.payload), this.cursor);
    this.cursor += 8;
    // Convert big-integer to native bigint. For unsigned semantics the caller
    // should interpret the resulting bigint appropriately.
    return BigInt(value.toString());
    }


    protected readVarInt(): number {
        return this.readVarInt1(0);
    }

    protected readVarInt1(offset: number): number {
        try {
            if (!this.payload) {
                throw new ProtocolException("Payload is null");
            }
            const varint = new VarInt(new Uint8Array(this.payload), this.cursor + offset);
            this.cursor += offset + varint.getOriginalSizeInBytes();
            // Convert BigInt to number
            return Number(varint.value);
        } catch (e) {
            if (e instanceof ArrayIndexOutOfBoundsException) {
                // Pass the error message instead of the exception object
                throw new ProtocolException(e.message || "Array index out of bounds");
            }
            throw e;
        }
    }


    protected readBytes(length: number): Uint8Array {
        if (length > Message.MAX_SIZE) {
            throw new ProtocolException("Claimed value length too large: " + length);
        }
        try {
            if (!this.payload) {
                throw new ProtocolException("Payload is null");
            }
            
            if (this.cursor + length > this.payload.length) {
                throw new ProtocolException(`Ran off the end of the buffer: tried to read ${length} bytes when only ${this.payload.length - this.cursor} were available`);
            }
            
            const b = new Uint8Array(length);
            b.set(this.payload.subarray(this.cursor, this.cursor + length));
            this.cursor += length;
            return b;
        } catch (e) {
            if (e instanceof IndexOutOfBoundsException) {
                console.debug(" payload.length " + (this.payload ? this.payload.length : 0) + " readBytes" + length);
                throw new ProtocolException(e.message || "Index out of bounds");
            }
            throw e;
        }
    }

    protected readByteArray(): Uint8Array {
        const len = this.readVarInt();
        if (len > Message.MAX_SIZE) {
            throw new ProtocolException("Claimed value length too large: " + len);
        }
        return this.readBytes(len);
    }

    protected readStr(): string {
        const length = this.readVarInt();
        if (length > Message.MAX_SIZE) {
            throw new ProtocolException("Claimed value length too large: " + length);
        }
        if (length === 0) return ""; // optimization for empty strings
        const bytes = this.readBytes(length);
        const decoder = new TextDecoder("utf-8");
        return decoder.decode(bytes);
    }

    protected readHash(): Sha256Hash {
        // We have to flip it around, as it's been read off the wire in little endian.
        // Not the most efficient way to do this but the clearest.
        return Sha256Hash.wrapReversed(new Uint8Array(this.readBytes(32)));
    }

    protected hasMoreBytes(): boolean {
        return this.payload !== null && this.cursor < this.payload.length;
    }

    /** Network parameters this message was created with. */
    public getParams(): NetworkParameters | null {
        return this.params;
    }

    /**
     * Set the serializer for this message when deserialized by Java.
     */
    private readObject(inStream: any): void {
        // In TypeScript, we don't need to implement this method as it's specific to Java serialization
    }
}

// Helper classes for exceptions
class ArrayIndexOutOfBoundsException extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "ArrayIndexOutOfBoundsException";
    }
}

class IndexOutOfBoundsException extends Error {
    constructor(message?: string) {
        super(message);
        this.name = "IndexOutOfBoundsException";
    }
}
