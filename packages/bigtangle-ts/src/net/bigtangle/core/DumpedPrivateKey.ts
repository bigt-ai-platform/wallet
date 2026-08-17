import { NetworkParameters } from '../params/NetworkParameters';
import { VersionedChecksummedBytes } from './VersionedChecksummedBytes';
import { ECKey } from './ECKey';
import { PQKey } from '../crypto/pq/PQKey';
import { AddressFormatException } from '../exception/AddressFormatException';
import { WrongNetworkException } from '../exception/WrongNetworkException';

/**
 * Parses and generates private keys in the form used by the Bitcoin "dumpprivkey" command (WIF). This is the private key
 * bytes with a header byte and 4 checksum bytes at the end. If there are 33 private key bytes instead of 32, then
 * the last byte is a discriminator value for the compressed pubkey.
 *
 * <p>Re-introduced so legacy EC private keys can be imported/exported in the
 * standard WIF form alongside the new {@code PQKey} type.</p>
 */
export class DumpedPrivateKey extends VersionedChecksummedBytes {
    private compressed: boolean;
    private params: NetworkParameters | null;

    /**
     * Construct a private key from its Base58 representation.
     */
    public static fromBase58(base58: string): DumpedPrivateKey;
    public static fromBase58(params: NetworkParameters | null, base58: string): DumpedPrivateKey;
    public static fromBase58(...args: any[]): DumpedPrivateKey {
        let params: NetworkParameters | null = null;
        let base58: string;
        if (args.length === 2) {
            params = args[0] as NetworkParameters | null;
            base58 = args[1] as string;
        } else {
            base58 = args[0] as string;
        }
        const vcb = VersionedChecksummedBytes.fromBase58(base58);
        if (params !== null && vcb.getVersion() !== params.getDumpedPrivateKeyHeader()) {
            throw new WrongNetworkException(vcb.getVersion(), [params.getDumpedPrivateKeyHeader()]);
        }
        const bytes = vcb.getBytes();
        let compressed: boolean;
        let privBytes: Uint8Array;
        if (bytes.length === 33 && bytes[32] === 1) {
            compressed = true;
            privBytes = bytes.slice(0, 32);
        } else if (bytes.length === 32) {
            compressed = false;
            privBytes = bytes;
        } else {
            throw new AddressFormatException('Wrong number of bytes for a private key, not 32 or 33');
        }
        return new DumpedPrivateKey(params!, privBytes, compressed);
    }

    /** Legacy alias for {@link #fromBase58(NetworkParameters, String)}. */
    public static fromBase58WithParams(base58: string, params: NetworkParameters): DumpedPrivateKey {
        return DumpedPrivateKey.fromBase58(params, base58);
    }

    public static parseBase58(params: NetworkParameters, base58: string): DumpedPrivateKey {
        return DumpedPrivateKey.fromBase58(params, base58);
    }

    // Used by ECKey.getPrivateKeyAsWiF()
    public constructor(params: NetworkParameters, keyBytes: Uint8Array, compressed: boolean) {
        super(params.getDumpedPrivateKeyHeader(), DumpedPrivateKey.encode(keyBytes, compressed));
        this.params = params;
        this.compressed = compressed;
    }

    private static encode(keyBytes: Uint8Array, compressed: boolean): Uint8Array {
        if (keyBytes.length !== 32) {
            throw new Error('Private keys must be 32 bytes');
        }
        if (!compressed) {
            return keyBytes;
        }
        // Keys that have compressed public components have an extra 1 byte on the end in dumped form.
        const bytes = new Uint8Array(33);
        bytes.set(keyBytes, 0);
        bytes[32] = 1;
        return bytes;
    }

    public static encodePrivateKey(params: NetworkParameters, privKeyBytes: Uint8Array, compressed: boolean): DumpedPrivateKey {
        if (privKeyBytes.length !== 32) {
            throw new Error('Private key must be 32 bytes');
        }
        return new DumpedPrivateKey(params, privKeyBytes, compressed);
    }

    public isCompressed(): boolean {
        return this.compressed;
    }

    /** Returns an ECKey created from this encoded private key. */
    public getKey(): ECKey {
        const bytes = this.getBytes();
        const compressed = bytes.length === 33 && bytes[32] === 1;
        const privBytes = compressed ? bytes.slice(0, 32) : bytes;
        const key = ECKey.fromPrivate(privBytes, true);
        return compressed ? key : key.decompress();
    }

    /** Returns a PQKey created from this private key. */
    public toPQKey(): PQKey {
        throw new Error("EC dumped private key cannot be converted to PQ key; use PQKey.createNew()");
    }

    public toString(): string {
        return super.toString();
    }

    public clone(): DumpedPrivateKey {
        return new DumpedPrivateKey(
            this.params!,
            this.compressed ? this.getBytes().slice(0, 32) : this.getBytes(),
            this.compressed
        );
    }
}
