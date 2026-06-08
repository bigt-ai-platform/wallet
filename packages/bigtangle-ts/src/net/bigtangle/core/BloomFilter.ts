import { ECKey } from './ECKey';
import { NetworkParameters } from '../params/NetworkParameters';
import { Message } from './Message';

export enum BloomUpdate {
    UPDATE_NONE = 0,
    UPDATE_ALL = 1,
    UPDATE_P2PUBKEY_ONLY = 2
}

export class BloomFilter extends Message {
    private static readonly MAX_FILTER_SIZE = 36000;
    private static readonly MAX_HASH_FUNCS = 50;
    private static readonly E = Math.E;

    private data: Uint8Array = new Uint8Array(0);
    private hashFuncs: number = 0;
    private nTweak: number = 0;
    private nFlags: number = 0;

    constructor(params: NetworkParameters, elements?: number, falsePositiveRate?: number, nTweak?: number, nFlags?: number);
    constructor(params: NetworkParameters, payload?: Uint8Array);
    constructor(params: NetworkParameters, p1?: number | Uint8Array, falsePositiveRate?: number, nTweak?: number, nFlags?: number) {
        super(params);
        
        if (p1 instanceof Uint8Array) {
            // Constructor with payload - parse the payload
            this.payload = p1;
            this.offset = 0;
            this.length = p1.length;
            this.parse();
        } else if (p1 !== undefined && typeof p1 === 'number' && falsePositiveRate !== undefined && nTweak !== undefined) {
            // Create a new filter
            const elements = p1;
            const ln2 = Math.log(2);
            this.data = new Uint8Array(Math.ceil(-elements * Math.log(falsePositiveRate) / (ln2 * ln2) / 8));
            this.hashFuncs = Math.floor(this.data.length * 8 / elements * Math.log(2));
            this.nTweak = nTweak;
            this.nFlags = nFlags || BloomUpdate.UPDATE_P2PUBKEY_ONLY;
        }
    }

    static create(params: NetworkParameters, elements: number, falsePositiveRate: number, randomNonce: number, updateFlag: BloomUpdate = BloomUpdate.UPDATE_P2PUBKEY_ONLY): BloomFilter {
        return new BloomFilter(params, elements, falsePositiveRate, randomNonce, updateFlag);
    }

    getFalsePositiveRate(elements: number): number {
        return Math.pow(1 - Math.pow(BloomFilter.E, -1.0 * (this.hashFuncs * elements) / (this.data.length * 8)), this.hashFuncs);
    }

    toString(): string {
        return `Bloom Filter of size ${this.data.length} with ${this.hashFuncs} hash functions.`;
    }

    protected parse(): void {
        let localOffset = this.offset;
        
        // Ensure payload exists
        if (!this.payload || this.payload.length === 0) {
            throw new Error("Invalid data: missing or empty payload");
        }
        
        // Read data length (varint)
        let dataLength = 0;
        const firstByte = this.payload[localOffset];
        localOffset++;
        
        if (firstByte < 0xfd) {
            dataLength = firstByte;
        } else if (firstByte === 0xfd) {
            dataLength = (this.payload[localOffset]) | (this.payload[localOffset + 1] << 8);
            localOffset += 2;
        } else if (firstByte === 0xfe) {
            dataLength = (this.payload[localOffset]) |
                        (this.payload[localOffset + 1] << 8) |
                        (this.payload[localOffset + 2] << 16) |
                        (this.payload[localOffset + 3] << 24);
            localOffset += 4;
        } else {
            const low = (this.payload[localOffset]) |
                       (this.payload[localOffset + 1] << 8) |
                       (this.payload[localOffset + 2] << 16) |
                       (this.payload[localOffset + 3] << 24);
            const high = (this.payload[localOffset + 4]) |
                        (this.payload[localOffset + 5] << 8) |
                        (this.payload[localOffset + 6] << 16) |
                        (this.payload[localOffset + 7] << 24);
            // Handle 64-bit integer correctly using JavaScript's Number type
            // This works for values up to Number.MAX_SAFE_INTEGER
            // Use a safer approach to avoid TypeScript errors
            dataLength = low;
            if (high > 0) {
                // Use a workaround to avoid TypeScript errors
                // Calculate 0x100000000 * high using string manipulation
                const highStr = high.toString();
                const resultStr = highStr + "00000000"; // Append 8 zeros
                const result = parseInt(resultStr, 10);
                dataLength += result;
            }
            localOffset += 8;
        }
        
        if (dataLength > BloomFilter.MAX_FILTER_SIZE) {
            throw new Error("Bloom filter out of size range.");
        }
        
        // Read data
        this.data = new Uint8Array(this.payload.subarray(localOffset, localOffset + dataLength));
        localOffset += dataLength;
        
        // Read hash functions (uint32)
        this.hashFuncs = (this.payload[localOffset]) |
                        (this.payload[localOffset + 1] << 8) |
                        (this.payload[localOffset + 2] << 16) |
                        (this.payload[localOffset + 3] << 24);
        localOffset += 4;

        if (this.hashFuncs > BloomFilter.MAX_HASH_FUNCS) {
            throw new Error("Bloom filter hash function count out of range");
        }

        // Read nTweak (uint32)
        this.nTweak = (this.payload[localOffset]) |
                     (this.payload[localOffset + 1] << 8) |
                     (this.payload[localOffset + 2] << 16) |
                     (this.payload[localOffset + 3] << 24);
        localOffset += 4;
        
        // Read flags (byte)
        this.nFlags = this.payload[localOffset];
        this.length = localOffset - this.offset;
    }
    
    public bitcoinSerializeToStream(stream: any): void {
        const serialized = this.serialize();
        stream.write(serialized);
    }
    
    public bitcoinSerialize(): Uint8Array {
        return this.serialize();
    }
    
    public getMessageSize(): number {
        return this.serialize().length;
    }

    serialize(): Uint8Array {
        // Manually serialize varint for data length
        const varintParts: Uint8Array[] = [];
        const dataLength = this.data.length;
        
        if (dataLength < 0xfd) {
            varintParts.push(new Uint8Array([dataLength]));
        } else if (dataLength <= 0xffff) {
            varintParts.push(new Uint8Array([0xfd]));
            const lenBuf = new Uint8Array(2);
            lenBuf[0] = dataLength & 0xff;
            lenBuf[1] = (dataLength >> 8) & 0xff;
            varintParts.push(lenBuf);
        } else if (dataLength <= 0xffffffff) {
            varintParts.push(new Uint8Array([0xfe]));
            const lenBuf = new Uint8Array(4);
            lenBuf[0] = dataLength & 0xff;
            lenBuf[1] = (dataLength >> 8) & 0xff;
            lenBuf[2] = (dataLength >> 16) & 0xff;
            lenBuf[3] = (dataLength >> 24) & 0xff;
            varintParts.push(lenBuf);
        } else {
            varintParts.push(new Uint8Array([0xff]));
            const low = dataLength % 0x100000000;
            const high = Math.floor(dataLength / 0x100000000);
            const lenBuf = new Uint8Array(8);
            lenBuf[0] = low & 0xff;
            lenBuf[1] = (low >> 8) & 0xff;
            lenBuf[2] = (low >> 16) & 0xff;
            lenBuf[3] = (low >> 24) & 0xff;
            lenBuf[4] = high & 0xff;
            lenBuf[5] = (high >> 8) & 0xff;
            lenBuf[6] = (high >> 16) & 0xff;
            lenBuf[7] = (high >> 24) & 0xff;
            varintParts.push(lenBuf);
        }
        
        const varintBufLength = varintParts.reduce((sum, buf) => sum + buf.length, 0);
        const varintBuf = new Uint8Array(varintBufLength);
        let varintOffset = 0;
        for (const part of varintParts) {
            varintBuf.set(part, varintOffset);
            varintOffset += part.length;
        }
        const buffer = new Uint8Array(varintBuf.length + this.data.length + 4 + 4 + 1);
        let offset = 0;
        
        // Write data length (varint)
        buffer.set(varintBuf, offset);
        offset += varintBuf.length;
        
        // Write data
        buffer.set(this.data, offset);
        offset += this.data.length;
        
        // Write hash functions (uint32LE)
        buffer[offset] = this.hashFuncs & 0xff;
        buffer[offset + 1] = (this.hashFuncs >> 8) & 0xff;
        buffer[offset + 2] = (this.hashFuncs >> 16) & 0xff;
        buffer[offset + 3] = (this.hashFuncs >> 24) & 0xff;
        offset += 4;

        // Write nTweak (uint32LE)
        buffer[offset] = this.nTweak & 0xff;
        buffer[offset + 1] = (this.nTweak >> 8) & 0xff;
        buffer[offset + 2] = (this.nTweak >> 16) & 0xff;
        buffer[offset + 3] = (this.nTweak >> 24) & 0xff;
        offset += 4;

        // Write flags (byte)
        buffer[offset] = this.nFlags;
        
        return buffer;
    }

    private static rotateLeft32(x: number, r: number): number {
        return (x << r) | (x >>> (32 - r));
    }

    private static murmurHash3(data: Uint8Array, nTweak: number, hashNum: number, object: Uint8Array): number {
        let h1 = hashNum * 0xFBA4C795 + nTweak;
        const c1 = 0xcc9e2d51;
        const c2 = 0x1b873593;

        const numBlocks = Math.floor(object.length / 4) * 4;
        
        // Process 4-byte blocks
        for (let i = 0; i < numBlocks; i += 4) {
            let k1 = object[i] |
                (object[i + 1] << 8) |
                (object[i + 2] << 16) |
                (object[i + 3] << 24);
            
            k1 *= c1;
            k1 = BloomFilter.rotateLeft32(k1, 15);
            k1 *= c2;

            h1 ^= k1;
            h1 = BloomFilter.rotateLeft32(h1, 13);
            h1 = h1 * 5 + 0xe6546b64;
        }
        
        let k1 = 0;
        const tailStart = numBlocks;
        const remaining = object.length & 3;
        
        switch (remaining) {
            case 3:
                k1 ^= object[tailStart + 2] << 16;
            // Fall through
            case 2:
                k1 ^= object[tailStart + 1] << 8;
            // Fall through
            case 1:
                k1 ^= object[tailStart];
                k1 *= c1;
                k1 = BloomFilter.rotateLeft32(k1, 15);
                k1 *= c2;
                h1 ^= k1;
        }

        // Finalization
        h1 ^= object.length;
        h1 ^= h1 >>> 16;
        h1 *= 0x85ebca6b;
        h1 ^= h1 >>> 13;
        h1 *= 0xc2b2ae35;
        h1 ^= h1 >>> 16;
        
        return (h1 >>> 0) % (data.length * 8);
    }

    contains(object: Uint8Array): boolean {
        for (let i = 0; i < this.hashFuncs; i++) {
            const bitIndex = BloomFilter.murmurHash3(this.data, this.nTweak, i, object);
            if (!this.checkBitLE(bitIndex)) {
                return false;
            }
        }
        return true;
    }

    insert(object: Uint8Array) {
        for (let i = 0; i < this.hashFuncs; i++) {
            const bitIndex = BloomFilter.murmurHash3(this.data, this.nTweak, i, object);
            this.setBitLE(bitIndex);
        }
    }

    private checkBitLE(bitIndex: number): boolean {
        const byteIndex = Math.floor(bitIndex / 8);
        const bit = bitIndex % 8;
        return (this.data[byteIndex] & (1 << bit)) !== 0;
    }

    private setBitLE(bitIndex: number) {
        const byteIndex = Math.floor(bitIndex / 8);
        const bit = bitIndex % 8;
        this.data[byteIndex] |= (1 << bit);
    }

    insertKey(key: ECKey) {
        // These methods don't exist on ECKey, need to implement differently
        // Placeholder until we fix ECKey implementation
        throw new Error("insertKey not implemented yet");
    }

    setMatchAll() {
        this.data = new Uint8Array([0xff]);
    }

    merge(filter: BloomFilter) {
        if (!this.matchesAll() && !filter.matchesAll()) {
            if (filter.data.length !== this.data.length ||
                filter.hashFuncs !== this.hashFuncs ||
                filter.nTweak !== this.nTweak) {
                throw new Error("Filters must have the same size, hash function count, and nTweak");
            }
            
            for (let i = 0; i < this.data.length; i++) {
                this.data[i] |= filter.data[i];
            }
        } else {
            this.data = new Uint8Array([0xff]);
        }
    }

    matchesAll(): boolean {
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== 0xff) {
                return false;
            }
        }
        return true;
    }

    equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof BloomFilter)) return false;
        if (this.data.length !== other.data.length) return false;
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] !== other.data[i]) return false;
        }
        return this.hashFuncs === other.hashFuncs &&
            this.nTweak === other.nTweak;
    }

    hashCode(): number {
        let hash = 17;
        // Simple hash calculation for buffer
        for (let i = 0; i < this.data.length; i++) {
            hash = 31 * hash + this.data[i];
        }
        hash = 31 * hash + this.hashFuncs;
        hash = 31 * hash + this.nTweak;
        return hash;
    }
}
