import { NetworkParameters } from '../params/NetworkParameters';
import { VersionedChecksummedBytes } from './VersionedChecksummedBytes';
import { ECKey } from './ECKey';

export class DumpedPrivateKey extends VersionedChecksummedBytes {
    private compressed: boolean;
    private params: NetworkParameters;

    constructor(params: NetworkParameters, bytes: Uint8Array, compressed: boolean = false) {
        // Use the dumped private key header from network parameters as the version
        super(params.getDumpedPrivateKeyHeader(), bytes);
        this.params = params;
        this.compressed = compressed;
    }

    public static fromBase58(base58: string): DumpedPrivateKey {
        throw new Error("Use fromBase58WithParams instead");
    }

    public static fromBase58WithParams(base58: string, params: NetworkParameters): DumpedPrivateKey {
        const versionedChecksummedBytes = VersionedChecksummedBytes.fromBase58(base58);
        // The last byte indicates compression (0x01) if present
        const bytes = versionedChecksummedBytes.getBytes();
        let compressed = false;
        if (bytes.length === 34 && bytes[33] === 1) {
            compressed = true;
        }
        return new DumpedPrivateKey(params, bytes, compressed);
    }
    
    public static parseBase58(params: NetworkParameters, base58: string): DumpedPrivateKey {
        return DumpedPrivateKey.fromBase58WithParams(base58, params);
    }

    public static encodePrivateKey(params: NetworkParameters, privKeyBytes: Uint8Array, compressed: boolean): DumpedPrivateKey {
        if (privKeyBytes.length !== 32) {
            throw new Error('Private key must be 32 bytes');
        }
        const bytes = new Uint8Array(compressed ? 33 : 32);
        bytes.set(privKeyBytes, 0);
        if (compressed) {
            bytes[32] = 1; // Compression marker
        }
        return new DumpedPrivateKey(params, bytes, compressed);
    }


    public isCompressed(): boolean {
        return this.compressed;
    }

    /**
     * Returns an ECKey created from this private key.
     */
    public toECKey(): ECKey {
        const privKeyBytes = this.getBytes();
        let keyBytes: Uint8Array;
        let compressed = this.compressed;
        
        if (privKeyBytes.length === 33 && privKeyBytes[32] === 1) {
            // Compressed private key with marker byte
            keyBytes = privKeyBytes.slice(0, 32);
            compressed = true;
        } else if (privKeyBytes.length === 32) {
            // Uncompressed private key
            keyBytes = privKeyBytes;
            compressed = false;
        } else {
            throw new Error(`Invalid private key format: length=${privKeyBytes.length}`);
        }
        
        const hex = Array.from(new Uint8Array(keyBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
        const privKey = BigInt('0x' + hex);
        return ECKey.fromPrivate(privKey, compressed);
    }

    public toString(): string {
        return super.toString();
    }
    
    public clone(): DumpedPrivateKey {
        return new DumpedPrivateKey(
            this.params,
            new Uint8Array(this.getBytes()),
            this.compressed
        );
    }
}
