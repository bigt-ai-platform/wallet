import { MessageDigestSpi } from './MessageDigestSpi';
import { sha256 } from '@noble/hashes/sha256';

export class SHA256DigestSpi extends MessageDigestSpi {
    private hashBuffer: Uint8Array[] = [];
    
    protected engineUpdateByte(input: number): void {
        this.hashBuffer.push(new Uint8Array([input]));
    }

    protected engineUpdateBytes(input: Uint8Array, offset: number, len: number): void {
        this.hashBuffer.push(input.subarray(offset, offset + len));
    }
    
    protected engineDigest(): Uint8Array {
        // Flatten all buffers into a single Uint8Array
        const totalLength = this.hashBuffer.reduce((sum, buf) => sum + buf.length, 0);
        const combinedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const buffer of this.hashBuffer) {
            combinedBuffer.set(buffer, offset);
            offset += buffer.length;
        }
        const hashResult = sha256(combinedBuffer);
        // Return as Buffer to maintain compatibility with existing tests
        return new Uint8Array(hashResult);
    }
    
    protected engineReset(): void {
        this.hashBuffer = [];
    }
    
    protected engineGetDigestLength(): number {
        return 32; // SHA-256 produces 32-byte digests
    }
}
