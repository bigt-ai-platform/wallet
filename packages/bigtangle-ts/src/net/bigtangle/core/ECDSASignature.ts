// ECDSASignature.ts
// TypeScript translation of ECDSASignature from ECKey.java
// Combined version with strict BIP-66 DER encoding and additional methods

;

import * as asn1js from 'asn1js';
import { InvalidTransactionDataException } from '../exception/Exceptions';

// The order of the curve
const CURVE_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
// The half order of the curve
const HALF_CURVE_ORDER = CURVE_N / 2n;

export class ECDSASignature {
    public r: bigint;
    public s: bigint;

    /**
     * Constructs a signature with the given components. Does NOT automatically canonicalise the signature.
     */
    constructor(r: bigint, s: bigint) {
        this.r = r;
        this.s = s;
    }

    /**
     * Returns true if the S component is "low", that means it is below HALF_CURVE_ORDER. See
     * <a href="https://github.com/bitcoin/bips/blob/master/bip-0062.mediawiki#Low_S_values_in_signatures">BIP62</a>.
     */
    public isCanonical(): boolean {
        return this.s <= HALF_CURVE_ORDER;
    }

    /**
     * Will automatically adjust the S component to be less than or equal to half the curve order, if necessary.
     * This is required because for every signature (r,s) the signature (r, -s (mod N)) is a valid signature of
     * the same message. However, we dislike the ability to modify the bits of a Bitcoin transaction after it's
     * been signed, as that violates various assumed invariants. Thus in future only one of those forms will be
     * considered legal and the other will be banned.
     */
    public toCanonicalised(): ECDSASignature {
        if (!this.isCanonical()) {
            // The order of the curve is the number of valid points that exist on that curve. If S is in the upper
            // half of the number of valid points, then bring it back to the lower half. Otherwise, imagine that
            //    N = 10
            //    s = 8, so (-8 % 10 == 2) thus both (r, 8) and (r, 2) are valid solutions.
            //    10 - 8 == 2, giving us always the latter solution, which is canonical.
            return new ECDSASignature(this.r, CURVE_N - this.s);
        } else {
            return this;
        }
    }

    /**
     * DER is an international standard for serializing data structures which is widely used in cryptography.
     * It's somewhat like protocol buffers but less convenient. This method returns a standard DER encoding
     * of the signature, as recognized by OpenSSL and other libraries.
     */
    public encodeToDER(): Uint8Array {
        // Use the BIP-66 compliant implementation to ensure strict compliance
        return this.encodeDERStrict();
    }

    /**
     * Alias for encodeToDER for compatibility with TransactionSignature
     */
    public encodeDER(): Uint8Array {
        return this.encodeToDER();
    }

    /**
     * Strict BIP-66 DER encoding implementation (for compatibility with crypto version)
     */
    public encodeDERStrict(): Uint8Array {
        // Convert r and s to minimal signed DER format (following Bitcoin's DER rules)
        
        // Convert r to DER integer format
        let rBytes = this.toDERInteger(this.r);
        
        // Convert s to DER integer format  
        let sBytes = this.toDERInteger(this.s);

        // Calculate total length of the content after the sequence tag
        const totalLen = rBytes.length + sBytes.length;

        // Create buffer with exact size needed for the complete DER signature
        const der = new Uint8Array(2 + totalLen); // SEQUENCE tag + length byte + content
        let offset = 0;

        der[offset++] = 0x30; // SEQUENCE tag
        der[offset++] = totalLen; // Length of the content that follows

        // Copy r and s DER-encoded integers
        der.set(rBytes, offset);
        offset += rBytes.length;
        der.set(sBytes, offset);

        return der;
    }
    
    /**
     * Convert a BigInteger to its DER integer representation following strict DER rules:
     * - If the value has the high bit set (>= 0x80), prepend 0x00 to indicate positive
     * - Ensure minimal encoding (no unnecessary leading 0x00)
     */
    private toDERInteger(value: bigint): Uint8Array {
        if (value === 0n) {
            return new Uint8Array([0x02, 0x01, 0x00]); // INTEGER, length=1, value=0
        }

        // For DER encoding, we need to represent the value as a signed integer
        // If the value is positive but would be interpreted as negative due to MSB set, 
        // we need to prepend a 0x00 byte
        
        // Convert the value to bytes using big-endian representation
        let hex = value.toString(16);
        if (hex.length % 2 !== 0) {
            hex = '0' + hex; // Ensure even number of hex chars
        }
        let bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

        // Remove non-significant leading zeros, but make sure we don't remove
        // a zero that's needed to keep the number positive
        while (bytes.length > 1 && bytes[0] === 0x00) {
            // Only remove the leading zero if the next byte doesn't have high bit set
            // (which would make the positive number appear negative)
            if ((bytes[1] & 0x80) === 0) {
                bytes = bytes.slice(1);
            } else {
                // If the next byte has high bit set, we need to keep this zero
                // to maintain the positive sign
                break;
            }
        }
        
        // If the first byte has the high bit set, this value would appear negative
        // in two's complement representation, so prepend a 0x00 to make it positive
        if ((bytes[0] & 0x80) !== 0) {
            const newBytes = new Uint8Array(bytes.length + 1);
            newBytes[0] = 0x00;
            newBytes.set(bytes, 1);
            bytes = newBytes;
        }
        
        // Verify that bytes length fits in a single byte (DER length field is 1 byte for lengths < 128)
        if (bytes.length > 127) {
            throw new Error(`Integer too large for DER encoding (length: ${bytes.length})`);
        }
        
        // Create the DER integer: tag (0x02) + length + value
        const result = new Uint8Array(2 + bytes.length);
        result[0] = 0x02; // INTEGER tag
        result[1] = bytes.length; // Length of value
        result.set(bytes, 2);
        
        return result;
    }

    /**
     * Returns the signature as a Buffer in compact format (r, s concatenated, 64 bytes).
     */
    public toCompact(): Uint8Array {
        const rHex = this.r.toString(16).padStart(64, '0');
        const sHex = this.s.toString(16).padStart(64, '0');

        const rBytes = new Uint8Array(rHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        const sBytes = new Uint8Array(sHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

        const result = new Uint8Array(64);
        result.set(rBytes, 0);
        result.set(sBytes, 32);
        return result;
    }

    /**
     * Returns the signature as a hex string (DER encoded).
     */
    public toHexDER(): string {
        return Array.from(this.encodeDER()).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Returns the signature as a hex string (compact format).
     */
    public toHexCompact(): string {
        return Array.from(this.toCompact()).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Parse a DER-encoded signature Buffer into an ECDSASignature.
     * This is a strict implementation that follows Bitcoin's BIP-66.
     */
    public static decodeDER(buffer: Uint8Array): ECDSASignature {
        if (buffer.length < 8 || buffer.length > 72) throw new InvalidTransactionDataException('Invalid DER signature length');
        if (buffer[0] !== 0x30) throw new InvalidTransactionDataException('Invalid DER sequence');
        
        const totalLen = buffer[1];
        if (totalLen !== buffer.length - 2) throw new InvalidTransactionDataException('Invalid DER length');

        let offset = 2;
        if (buffer[offset] !== 0x02) throw new InvalidTransactionDataException('Invalid DER integer for r');
        offset++;

        const rLen = buffer[offset];
        offset++;
        if (rLen === 0) throw new InvalidTransactionDataException('r length is zero');
        if (buffer[offset] & 0x80) throw new InvalidTransactionDataException('r is negative');
        if (rLen > 1 && buffer[offset] === 0x00 && !(buffer[offset + 1] & 0x80)) throw new InvalidTransactionDataException('r is not minimally encoded');
        
        const rSlice = buffer.slice(offset, offset + rLen);
        const r = BigInt('0x' + Array.from(rSlice).map(b => b.toString(16).padStart(2, '0')).join(''));
        offset += rLen;

        if (buffer[offset] !== 0x02) throw new InvalidTransactionDataException('Invalid DER integer for s');
        offset++;

        const sLen = buffer[offset];
        offset++;
        if (sLen === 0) throw new InvalidTransactionDataException('s length is zero');
        if (buffer[offset] & 0x80) throw new InvalidTransactionDataException('s is negative');
        if (sLen > 1 && buffer[offset] === 0x00 && !(buffer[offset + 1] & 0x80)) throw new InvalidTransactionDataException('s is not minimally encoded');

        const sSlice = buffer.slice(offset, offset + sLen);
        const s = BigInt('0x' + Array.from(sSlice).map(b => b.toString(16).padStart(2, '0')).join(''));
        offset += sLen;

        if (offset !== buffer.length) throw new InvalidTransactionDataException('Extra data at end of signature');

        return new ECDSASignature(r, s);
    }

    /**
     * Alternative DER decoder using asn1js (for compatibility with existing functionality)
     */
    public static decodeFromDER(bytes: Uint8Array): ECDSASignature {
        // First, try the strict BIP-66 decoder
        try {
            return ECDSASignature.decodeDER(new Uint8Array(bytes));
        } catch (e) {
            // If BIP-66 fails, try the asn1js decoder as fallback
            try {
                // Create a new ArrayBuffer from the Uint8Array to ensure compatibility
                const arrayBuffer = new ArrayBuffer(bytes.length);
                const uint8Array = new Uint8Array(arrayBuffer);
                uint8Array.set(bytes);
                
                const asn1 = asn1js.fromBER(arrayBuffer);
                if (asn1.offset === -1) {
                    throw new Error("Invalid ASN.1 structure");
                }

                const sequence = asn1.result as asn1js.Sequence;
                if (!sequence || !sequence.valueBlock || !(sequence.valueBlock as any).value || (sequence.valueBlock as any).value.length < 2) {
                    throw new Error("Invalid ASN.1 sequence structure");
                }
                
                const rValueBlock = (sequence.valueBlock as any).value[0].valueBlock;
                const sValueBlock = (sequence.valueBlock as any).value[1].valueBlock;
                
                if (!rValueBlock || !rValueBlock.valueHex || !sValueBlock || !sValueBlock.valueHex) {
                    throw new Error("Invalid ASN.1 integer values");
                }

                const rValue = rValueBlock.valueHex;
                const sValue = sValueBlock.valueHex;

                const r = BigInt('0x' + Array.from(new Uint8Array(rValue)).map(b => b.toString(16).padStart(2, '0')).join(''));
                const s = BigInt('0x' + Array.from(new Uint8Array(sValue)).map(b => b.toString(16).padStart(2, '0')).join(''));

                return new ECDSASignature(r, s);
            } catch (e2) {
                throw new Error(`Could not decode DER: ${e2}`);
            }
        }
    }

    /**
     * Recover public key from signature and message hash
     */
    public recoverPublicKey(messageHash: Uint8Array, recoveryId: number): Uint8Array {
        // This method is currently not implemented with the secp256k1 library
        // It would require proper signature format conversion and recovery
        // For now, throw an error to indicate it's not supported
        throw new Error("recoverPublicKey not implemented with secp256k1 library");
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (o == null || !(o instanceof ECDSASignature)) return false;
        return this.r === o.r && this.s === o.s;
    }

    public hashCode(): number {
        // This is a simple implementation for API compatibility with the original Java code.
        // In JavaScript, objects are not typically hashed for map keys based on content.
        // Using a simple hashing approach.
        const rStr = this.r.toString();
        const sStr = this.s.toString();
        let hash = 17;
        hash = hash * 31 + rStr.length;
        hash = hash * 31 + sStr.length;
        return hash;
    }
}
