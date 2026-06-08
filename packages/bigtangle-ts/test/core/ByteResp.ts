
import { Buffer } from 'buffer';

export class ByteResp {
    private data: Buffer = Buffer.alloc(0);

    public getData(): Buffer {
        return this.data;
    }

    public setData(data: Buffer): void {
        this.data = data;
    }
}
