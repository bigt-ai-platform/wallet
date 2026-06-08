import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';

export class Contact {
    private name: string = "";
    private address: string = "";

    public getName(): string {
        return this.name;
    }

    public setName(name: string): void {
        this.name = name;
    }

    public getAddress(): string {
        return this.address;
    }

    public setAddress(address: string): void {
        this.address = address;
    }

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            baos.writeNBytesString(this.name);
            baos.writeNBytesString(this.address);
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }
    
    public parseDIS(dis: DataInputStream): this {
        this.name = dis.readNBytesString() ?? "";
        this.address = dis.readNBytesString() ?? "";
        return this;
    }

    public parse(buf: Uint8Array): this {
        const buffer = new Uint8Array(buf); // Convert Uint8Array to Buffer
        const bain = new DataInputStream(buffer);
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }
}
