import { Base58 } from '../utils/Base58';
import { Sha256Hash } from './Sha256Hash';
import { Utils } from '../utils/Utils';
;

export class VersionedChecksummedBytes {
    protected version: number;
    protected bytes: Uint8Array;

    constructor(encoded: string);
    constructor(version: number, bytes: Uint8Array);
    constructor(...args: any[]) {
        if (args.length === 1 && typeof args[0] === 'string') {
            const encoded = args[0];
            const versionAndDataBytes = Base58.decodeChecked(encoded);
            this.version = versionAndDataBytes[0] & 0xFF;
            this.bytes = versionAndDataBytes.subarray(1);
        } else if (args.length === 2 && typeof args[0] === 'number' && args[1] instanceof Uint8Array) {
            const version = args[0];
            const bytes = args[1];
            if (version < 0 || version > 255) {
                throw new Error("Version must be between 0 and 255");
            }
            this.version = version;
            this.bytes = bytes;
        } else {
            throw new Error("Invalid constructor arguments");
        }
    }

    public toBase58(): string {
        const addressBytes = new Uint8Array(1 + this.bytes.length + 4);
        addressBytes[0] = this.version;
        addressBytes.set(this.bytes, 1);
        const checksum = Sha256Hash.hashTwice(new Uint8Array(addressBytes.subarray(0, this.bytes.length + 1))) ;
        addressBytes.set(checksum.subarray(0, 4), this.bytes.length + 1);
        return Base58.encode(addressBytes);
    }

    public toString(): string {
        return this.toBase58();
    }

    public hashCode(): number {
        let result = 17;
        result = 31 * result + this.version;
        for (let i = 0; i < this.bytes.length; i++) {
            result = 31 * result + this.bytes[i];
        }
        return result;
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (o === null || !(o instanceof VersionedChecksummedBytes)) return false;
        const other = o as VersionedChecksummedBytes;
        return this.version === other.version && Utils.bytesEqual(new Uint8Array(this.bytes), new Uint8Array(other.bytes));
    }

    public clone(): VersionedChecksummedBytes {
        // Create a new instance of the same class
        const cloned = Object.create(Object.getPrototypeOf(this));
        
        // Copy the version and bytes
        cloned.version = this.version;
        cloned.bytes = new Uint8Array(this.bytes);
        
        return cloned;
    }

    public compareTo(o: VersionedChecksummedBytes): number {
        let result = this.version - o.version;
        if (result !== 0) return result;
        
        const minLength = Math.min(this.bytes.length, o.bytes.length);
        for (let i = 0; i < minLength; i++) {
            result = (this.bytes[i] & 0xFF) - (o.bytes[i] & 0xFF);
            if (result !== 0) return result;
        }
        return this.bytes.length - o.bytes.length;
    }

    public static fromBase58(base58: string): VersionedChecksummedBytes {
        return new VersionedChecksummedBytes(base58);
    }

    public getVersion(): number {
        return this.version;
    }

    public getBytes(): Uint8Array {
        return this.bytes;
    }
}
