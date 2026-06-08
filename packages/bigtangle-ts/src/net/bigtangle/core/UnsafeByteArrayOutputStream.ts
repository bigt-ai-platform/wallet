import { Utils } from '../utils/Utils';

/**
 * An unsynchronized implementation of ByteArrayOutputStream that will return the backing byte array if its length == size().
 * This avoids unneeded array copy where the BOS is simply being used to extract a byte array of known length from a
 * 'serialized to stream' method.
 * <p/>
 * Unless the final length can be accurately predicted the only performance this will yield is due to unsynchronized
 * methods.
 
 */
export class UnsafeByteArrayOutputStream {
    private buf: Uint8Array;
    private count: number = 0;

    constructor(size: number = 168) {
        this.buf = new Uint8Array(size);
    }

    /**
     * Writes the specified byte to this byte array output stream.
     *
     * @param b the byte to be written.
     */
    public write(b: number | Buffer | Uint8Array): void {
        if (typeof b === 'number') {
            const newcount = this.count + 1;
            if (newcount > this.buf.length) {
                this.buf = Utils.copyOf(this.buf, Math.max(this.buf.length << 1, newcount));
            }
            this.buf[this.count] = b;
            this.count = newcount;
            // Debug: log single byte writes for tracing
            // (small overhead, acceptable for diagnosis)
         //   console.log(`UnsafeByteArrayOutputStream.write: wrote 1 byte, new size=${this.count}`);
        } else {
            const buffer = b instanceof Buffer ? b : new Uint8Array(b);
            this.writeBytes(buffer, 0, buffer.length);
        }
    }

    /**
     * Writes <code>len</code> bytes from the specified byte array
     * starting at offset <code>off</code> to this byte array output stream.
     *
     * @param b   the data.
     * @param off the start offset in the data.
     * @param len the number of bytes to write.
     */
    public writeBytes(b: Uint8Array, off: number, len: number): void {
        if ((off < 0) || (off > b.length) || (len < 0) ||
                ((off + len) > b.length) || ((off + len) < 0)) {
            throw new RangeError("IndexOutOfBoundsException");
        } else if (len === 0) {
            return;
        }
        const newcount = this.count + len;
        if (newcount > this.buf.length) {
            this.buf = Utils.copyOf(this.buf, Math.max(this.buf.length << 1, newcount));
        }
        this.buf.set(b.subarray(off, off + len), this.count);
        this.count = newcount;
    // Debug: log bulk writes for tracing
   // console.log(`UnsafeByteArrayOutputStream.writeBytes: wrote ${len} bytes, new size=${this.count}`);
    }

    /**
     * Writes the complete contents of this byte array output stream to
     * the specified output stream argument, as if by calling the output
     * stream's write method using <code>out.write(buf, 0, count)</code>.
     *
     * @param out the output stream to which to write the data.
     */
    public writeTo(out: any): void {
        out.write(this.buf, 0, this.count);
    }

    /**
     * Resets the <code>count</code> field of this byte array output
     * stream to zero, so that all currently accumulated output in the
     * output stream is discarded. The output stream can be used again,
     * reusing the already allocated buffer space.
     *
     * @see java.io.ByteArrayInputStream#count
     */
    public reset(): void {
        this.count = 0;
    }

    /**
     * Creates a newly allocated byte array. Its size is the current
     * size of this output stream and the valid contents of the buffer
     * have been copied into it.
     *
     * @return the current contents of this output stream, as a byte array.
     * @see java.io.ByteArrayOutputStream#size()
     */
    public toByteArray(): Uint8Array {
    // Diagnostic: log internal state to detect truncation/return issues
  
    return   Utils.copyOf(this.buf, this.count);
    }

    /**
     * Returns the current size of the buffer.
     *
     * @return the value of the <code>count</code> field, which is the number
     *         of valid bytes in this output stream.
     * @see java.io.ByteArrayOutputStream#count
     */
    public size(): number {
        return this.count;
    }

     public writeByte(byte: number): void {
        
            this.write(byte);
         
    }

 
    writeBoolean(val: boolean): void {
        this.writeByte(val ? 1 : 0);
    }

    writeInt(val: number): void {
        this.writeByte((val >>> 24) & 0xFF);
        this.writeByte((val >>> 16) & 0xFF);
        this.writeByte((val >>> 8) & 0xFF);
        this.writeByte(val & 0xFF);
    }

    writeUInt32LE(val: number): void {
        this.writeByte(val & 0xFF);
        this.writeByte((val >>> 8) & 0xFF);
        this.writeByte((val >>> 16) & 0xFF);
        this.writeByte((val >>> 24) & 0xFF);
    }

    writeLong(val: number): void {
        this.writeInt(Math.floor(val / 0x100000000));
        this.writeInt(val & 0xFFFFFFFF);
    }

    writeNBytesString(s: string | null | undefined): void {
        if (s === null || s === undefined) {
            this.writeBoolean(false);
        } else {
            this.writeBoolean(true);
            const encoder = new TextEncoder();
            const bytes = encoder.encode(s);
            this.writeInt(bytes.length);
            this.writeBytes(new Uint8Array(bytes), 0, bytes.length);
        }
    }

    close(): void {
        // No-op since we're just buffering in memory
    }
 
}
