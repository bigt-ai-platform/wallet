import { KeyValue } from './KeyValue';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { DataInputStream } from '../utils/DataInputStream';

export class TokenKeyValues {
    private keyvalues: KeyValue[] | null = null;

    public addKeyvalue(kv: KeyValue): void {
        if (this.keyvalues === null) {
            this.keyvalues = [];
        }
        this.keyvalues.push(kv);
    }

    public toByteArray(): Uint8Array {
        const dos = new UnsafeByteArrayOutputStream();
        const list = this.keyvalues;
        if (list === null) {
            dos.writeInt(0);
        } else {
            dos.writeInt(list.length);
            for (const kv of list) {
                const bytes = kv.toByteArray();
                dos.writeInt(bytes.length);
                dos.writeBytes(new Uint8Array(bytes), 0, bytes.length);
            }
        }
        dos.close();
        return dos.toByteArray();
    }

    public static parse(buf: Uint8Array): TokenKeyValues {
        const tkv = new TokenKeyValues();
        if (buf === null || buf === undefined || buf.length === 0) return tkv;
        const dis = new DataInputStream(new Uint8Array(buf));
        const size = dis.readInt();
        for (let i = 0; i < size; i++) {
            const len = dis.readInt();
            const bytes = dis.readBytes(len);
            tkv.addKeyvalue(new KeyValue().parse(bytes));
        }
        dis.close();
        return tkv;
    }

    public getKeyvalues(): KeyValue[] | null {
        return this.keyvalues;
    }
}
