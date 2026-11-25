import { DataInputStream } from '../utils/DataInputStream';
 
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty } from 'jackson-js';

export class KeyValue {
    @JsonProperty()
    private key: string;
    @JsonProperty()
    private value: string;

    constructor(key: string = '', value: string = '') {
        this.key = key;
        this.value = value;
    }

    public getKey(): string {
        return this.key;
    }

    public setKey(key: string): void {
        this.key = key;
    }

    public getValue(): string {
        return this.value;
    }

    public setValue(value: string): void {
        this.value = value;
    }

    public toByteArray(): Uint8Array {
        const dos = new UnsafeByteArrayOutputStream();
        
        try {
            dos.writeNBytesString(this.key);
            dos.writeNBytesString(this.value);
            dos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return dos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): KeyValue {
        this.key = dis.readNBytesString() ?? '';
        this.value = dis.readNBytesString() ?? '';
        return this;
    }

    public parse(buf: Uint8Array): KeyValue {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }
}
