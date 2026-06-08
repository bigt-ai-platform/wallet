import { ChildNumber } from './ChildNumber';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { ECKey } from '../core/ECKey';
import { ECPoint } from '../core/ECPoint'; // Added import

export class HDUtils {
    static formatPath(path: ChildNumber[]): string {
        if (path.length === 0) {
            return 'M';
        }
        return 'M/' + path.map(p => p.toString()).join('/');
    }

    static append(path: ChildNumber[], childNumber: ChildNumber): ChildNumber[] {
        return [...path, childNumber];
    }

    static hmacSha512(key: string | Uint8Array, data: Uint8Array): Uint8Array {
        const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
        return hmac(sha512, keyBytes, data);
    }

    static hmacSha512Bytes(chainCode: Uint8Array, data: Uint8Array): Uint8Array {
        return hmac(sha512, chainCode, data);
    }

    static toCompressed(key: ECKey | Uint8Array): Uint8Array {
        if (key instanceof ECKey) {
            return key.getPubKeyBytes(); // Already returns compressed
        } else if (key instanceof Uint8Array) {
            // Assume it's a public key in Uint8Array format, decode and re-encode compressed
            return ECPoint.decodePoint(key).encode(true);
        }
        throw new Error("Invalid key type for toCompressed");
    }

    static longTo4ByteArray(n: number): Uint8Array {
        const bytes = new Uint8Array(4);
        bytes[0] = (n >>> 24) & 0xff;
        bytes[1] = (n >>> 16) & 0xff;
        bytes[2] = (n >>> 8) & 0xff;
        bytes[3] = n & 0xff;
        return bytes;
    }

    static parsePath(path: string): ChildNumber[] {
        if (path === 'M') {
            return [];
        }
        const parts = path.split('/');
        if (parts[0] !== 'M') {
            throw new Error('Invalid path: must start with M');
        }
        return parts.slice(1).map(p => {
            const isHardened = p.endsWith('H');
            const value = parseInt(isHardened ? p.slice(0, -1) : p);
            return new ChildNumber(value, isHardened);
        });
    }
}
