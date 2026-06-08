;

export class ByteArrayInputStream {
    private buffer: Uint8Array;
    private position: number = 0;

    constructor(buffer: Uint8Array) {
        this.buffer = buffer;
    }

    public read(length: number): Uint8Array {
        const result = this.buffer.slice(this.position, this.position + length);
        this.position += length;
        return result;
    }

    public readByte(): number {
        const result = this.buffer[this.position];
        this.position += 1;
        return result;
    }

    public available(): number {
        return this.buffer.length - this.position;
    }

    public close(): void {
        // Nothing to do
    }
}
