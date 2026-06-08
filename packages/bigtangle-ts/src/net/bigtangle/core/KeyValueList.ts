import { DataClass } from './DataClass';
import { KeyValue } from './KeyValue';
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty, JsonClassType } from "jackson-js";

export class KeyValueList extends DataClass {
    @JsonProperty()
    @JsonClassType({type: () => [Array, [KeyValue]]})
    private keyvalues: KeyValue[] = [];

    public addKeyvalue(kv: KeyValue): void {
        this.keyvalues.push(kv);
    }

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            baos.writeBytes(superBytes, 0, superBytes.length);
            baos.writeInt(this.keyvalues.length);
            for (const c of this.keyvalues) {
                const bytes = new Uint8Array(c.toByteArray());
                baos.writeBytes(bytes, 0, bytes.length);
            }
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): this {
        super.parseDIS(dis);
        this.keyvalues = [];
        const size = dis.readInt();
        for (let i = 0; i < size; i++) {
            this.keyvalues.push(new KeyValue().parseDIS(dis));
        }
        return this;
    }

    public parse(buf: Uint8Array): this {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }

    public getKeyvalues(): KeyValue[] {
        return this.keyvalues;
    }

    public setKeyvalues(keyvalues: KeyValue[]): void {
        this.keyvalues = keyvalues;
    }
}
