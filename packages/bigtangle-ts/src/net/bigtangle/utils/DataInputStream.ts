;

export class DataInputStream {
    private buffer: Uint8Array;
    private position: number;

    constructor(buffer: Uint8Array) {
        this.buffer = buffer;
        this.position = 0;
    }

    public read(buffer: Uint8Array, offset: number, length: number): number {
        const bytesToRead = Math.min(length, this.buffer.length - this.position);
        buffer.set(this.buffer.subarray(this.position, this.position + bytesToRead), offset);
        this.position += bytesToRead;
        return bytesToRead;
    }

    public readBoolean(): boolean {
        return this.readByte() !== 0;
    }

    public readByte(): number {
        const val = this.buffer[this.position];
        this.position += 1;
        return val;
    }

    public readInt(): number {
        const val = (this.buffer[this.position] << 24) |
                   (this.buffer[this.position + 1] << 16) |
                   (this.buffer[this.position + 2] << 8) |
                   this.buffer[this.position + 3];
        this.position += 4;
        return val;
    }

    public readLong(): number {
        let val = 0n;
        for (let i = 0; i < 8; i++) {
            val = (val << 8n) | BigInt(this.buffer[this.position + i]);
        }
        this.position += 8;
        return Number(val);
    }

    public readBytes(length: number): Uint8Array {
        const buf = this.buffer.slice(this.position, this.position + length);
        this.position += length;
        return buf;
    }

    public readNBytesString(): string | null {
        const hasValue = this.readBoolean();
        if (hasValue) {
            const length = this.readInt();
            if (length < 0) {
                return null;
            }
            const buf = this.readBytes(length);
            return new TextDecoder().decode(buf);
        }
        return null;
    }

    public close(): void {
        // No-op
    }
}
