import { DataClass } from './DataClass';
import { Sha256Hash } from './Sha256Hash';
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty } from "jackson-js";

export class Spent extends DataClass {
    @JsonProperty()
    private confirmed: boolean = false;
    @JsonProperty()
    private spent: boolean = false;
    @JsonProperty()
    private spenderBlockHash: Sha256Hash | null = null;
    @JsonProperty()
    private time: number = 0;

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            baos.writeBytes(superBytes, 0, superBytes.length);
            baos.writeBoolean(this.confirmed);
            baos.writeBoolean(this.spent);
            const bytes = this.spenderBlockHash === null ? Sha256Hash.ZERO_HASH.getBytes() : this.spenderBlockHash.getBytes();
            baos.writeBytes(bytes, 0, bytes.length);
            baos.writeLong(this.time);
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): Spent {
        super.parseDIS(dis);
        this.confirmed = dis.readBoolean();
        this.spent = dis.readBoolean(); // This line appears twice in Java, replicating for now
        this.spenderBlockHash = Sha256Hash.wrap(dis.readBytes(32));
        if (this.spenderBlockHash!== null && this.spenderBlockHash.equals(Sha256Hash.ZERO_HASH)) {
            this.spenderBlockHash = null;
        }
        this.time = dis.readLong();
        return this;
    }

    public parse(buf: Uint8Array): Spent {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }

    public isConfirmed(): boolean {
        return this.confirmed;
    }

    public setConfirmed(confirmed: boolean): void {
        this.confirmed = confirmed;
    }

    public isSpent(): boolean {
        return this.spent;
    }

    public setSpent(spent: boolean): void {
        this.spent = spent;
    }

    public getSpenderBlockHash(): Sha256Hash | null {
        return this.spenderBlockHash;
    }

    public setSpenderBlockHash(spenderBlockHash: Sha256Hash | null): void {
        this.spenderBlockHash = spenderBlockHash;
    }

    public getTime(): number {
        return this.time;
    }

    public setTime(time: number): void {
        this.time = time;
    }

    public hashCode(): number {
        let result = 17;
        result = 31 * result + (this.confirmed ? 1 : 0);
        result = 31 * result + (this.spent ? 1 : 0);
        result = 31 * result + (this.spenderBlockHash ? Spent.hashBytesToInt(this.spenderBlockHash.getBytes()) : 0);
        result = 31 * result + this.time;
        return result;
    }

    public equals(obj: any): boolean {
        if (this === obj) return true;
        if (obj == null || this.constructor !== obj.constructor) return false;
        const other = obj as Spent;
        return this.confirmed === other.confirmed &&
               (this.spenderBlockHash === other.spenderBlockHash || (this.spenderBlockHash !== null && other.spenderBlockHash !== null && this.spenderBlockHash.equals(other.spenderBlockHash))) &&
               this.spent === other.spent &&
               this.time === other.time;
    }

    public toString(): string {
        return `Spent [confirmed=${this.confirmed}, spent=${this.spent}` +
               `, spenderBlockHash=${this.spenderBlockHash}, time=${this.time}]`;
    }

    // Utility method to hash bytes to int (simple implementation)
    private static hashBytesToInt(bytes: Uint8Array): number {
        let hash = 0;
        for (let i = 0; i < bytes.length; i++) {
            hash = ((hash << 5) - hash) + bytes[i];
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    }
}
