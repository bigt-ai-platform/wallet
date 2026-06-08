;
import { Utils } from '../utils/Utils';
import { MessageDigest } from '../utils/MessageDigest';
import { MessageDigestFactory } from '../utils/MessageDigestFactory';

/**
 * A Sha256Hash just wraps a byte[] so that equals and hashcode work correctly, allowing it to be used as keys in a
 * map. It also checks that the length is correct and provides a bit more type safety.
 */
export class Sha256Hash {
    private static readonly serialVersionUID = 7806870908693322289n;

    public static readonly LENGTH = 32; // bytes

    public static readonly ZERO_HASH = new Sha256Hash(new Uint8Array(32));

    private bytes: Uint8Array;

    /**
     * Use {@link #wrap(byte[])} instead.
     */
    constructor(rawHashBytes: Uint8Array) {
        if (rawHashBytes.length !== Sha256Hash.LENGTH) {
            throw new Error(`Sha256Hash must be exactly ${Sha256Hash.LENGTH} bytes`);
        }
        this.bytes = rawHashBytes;
    }

    public static wrap(rawHashBytes: Uint8Array ): Sha256Hash  {
      //  if (rawHashBytes === null || rawHashBytes.length === 0) return null;
        return new Sha256Hash(rawHashBytes);
    }

    public static wrapString(hexString: string ): Sha256Hash {
         return new Sha256Hash(new Uint8Array(Utils.HEX.decode(hexString)));
    }


    
    /**
     * Creates a new instance that wraps the given hash value, but with byte order reversed.
     *
     * @param rawHashBytes the raw hash bytes to wrap
     * @return a new instance
     * @throws IllegalArgumentException if the given array length is not exactly 32
     */
    public static wrapReversed(rawHashBytes: Uint8Array): Sha256Hash  {
      //  if (rawHashBytes.length !== Sha256Hash.LENGTH) return null;
        const reversed = new Uint8Array(Utils.reverseBytes(rawHashBytes));
        return new Sha256Hash(reversed);
    }

    /**
     * Returns a new instance containing the calculated (one-time) hash of the given bytes.
     *
     * @param contents the bytes on which the hash value is calculated
     * @return a new instance containing the calculated (one-time) hash
     */
    public static of(contents: Uint8Array): Sha256Hash {
        return new Sha256Hash(Sha256Hash.hash(contents));
    }

    /**
     * Creates a new instance containing the hash of the calculated hash of the given bytes.
     *
     * @param contents the bytes on which the hash value is calculated
     * @return a new instance containing the calculated (two-time) hash
     */
    public static twiceOf(contents: Uint8Array): Sha256Hash {
        return new Sha256Hash(Sha256Hash.hashTwice(contents));
    }

    /**
     * Returns the internal byte array as a Buffer.
     */
    public getBuffer(): Uint8Array {
        return new Uint8Array(this.bytes);
    }

    /**
     * Returns a new SHA-256 MessageDigest instance.
     * <p>
     * This is a convenience method which wraps the checked
     * exception that can never occur with a RuntimeException.
     *
     * @return a new SHA-256 MessageDigest instance
     */
    private static newDigest(): MessageDigest {
      
            return MessageDigestFactory.getInstance("SHA-256");
        
    }

    /**
     * Calculates the SHA-256 hash of the given bytes.
     *
     * @param input the bytes to hash
     * @return the hash (in big-endian order)
     */
    public static hash(input: Uint8Array): Uint8Array {
        return Sha256Hash.hashRange(input, 0, input.length);
    }

    /**
     * Calculates the SHA-256 hash of the given byte range.
     *
     * @param input the array containing the bytes to hash
     * @param offset the offset within the array of the bytes to hash
     * @param length the number of bytes to hash
     * @return the hash (in big-endian order)
     */
    public static hashRange(input: Uint8Array, offset: number, length: number): Uint8Array {
        const digest = Sha256Hash.newDigest();
        const subarray = input.subarray(offset, offset + length);
        digest.update(subarray);
        return new Uint8Array(digest.digest());
    }

    /**
     * Calculates the SHA-256 hash of the given bytes,
     * and then hashes the resulting hash again.
     *
     * @param input the bytes to hash
     * @return the double-hash (in big-endian order)
     */
    public static hashTwice(input: Uint8Array): Uint8Array {
        return Sha256Hash.hashTwiceRange(input, 0, input.length);
    }

    /**
     * Calculates the SHA-256 hash of the given byte range,
     * and then hashes the resulting hash again.
     *
     * @param input the array containing the bytes to hash
     * @param offset the offset within the array of the bytes to hash
     * @param length the number of bytes to hash
     * @return the double-hash (in big-endian order)
     */
    public static hashTwiceRange(input: Uint8Array, offset: number, length: number): Uint8Array {
        const digest = Sha256Hash.newDigest();
       
        digest.update(input, offset, length);
        const firstHash = digest.digest();
        digest.reset();
        digest.update(firstHash);
        return new Uint8Array(digest.digest());
    }

    /**
     * Calculates the hash of hash on the given byte ranges. This is equivalent to
     * concatenating the two ranges and then passing the result to {@link #hashTwice(byte[])}.
     */
    public static hashTwiceRanges(input1: Uint8Array, offset1: number, length1: number,
                                input2: Uint8Array, offset2: number, length2: number): Uint8Array {
        const digest = Sha256Hash.newDigest();
        const subarray1 = input1.subarray(offset1, offset1 + length1);
        const subarray2 = input2.subarray(offset2, offset2 + length2);
        digest.update(subarray1);
        digest.update(subarray2);
        const firstHash = digest.digest();
        // Simulate Java's digest.digest(firstHash) which does reset(), update(firstHash), digest()
        digest.reset();  // Reset the digest state
        digest.update(firstHash);
        return new Uint8Array(digest.digest());
    }

    public equals(other: Sha256Hash  ): boolean {
        if (this === other) return true;
        if (other === null || !(other instanceof Sha256Hash)) return false;
        return Utils.arraysEqual(this.bytes, other.bytes);
    }

    /**
     * Returns the last four bytes of the wrapped hash. This should be unique enough to be a suitable hash code even for
     * blocks, where the goal is to try and get the first bytes to be zeros (i.e. the value as a big integer lower
     * than the target value).
     */
    public hashCode(): number {
        // Use the last 4 bytes, not the first 4 which are often zeros in Bitcoin.
        const offset = this.bytes.length - 4;
        return (this.bytes[offset] << 24) |
               (this.bytes[offset + 1] << 16) |
               (this.bytes[offset + 2] << 8) |
               this.bytes[offset + 3];
    }

    public toString(): string {
        return Utils.HEX.encode(this.bytes);
    }

    /**
     * Returns the bytes interpreted as a positive integer.
     */
    public toBigInteger(): bigint {
        return BigInt('0x' + this.toString());
    }

    /**
     * Returns the internal byte array, without defensively copying. Therefore do NOT modify the returned array.
     */
    public getBytes(): Uint8Array {
        return this.bytes;
    }

    /**
     * Returns a reversed copy of the internal byte array.
     */
    public getReversedBytes(): Uint8Array {
        return new Uint8Array(Utils.reverseBytes(this.bytes));
    }

    public compareTo(other: Sha256Hash): number {
        for (let i = Sha256Hash.LENGTH - 1; i >= 0; i--) {
            const thisByte = this.bytes[i] & 0xff;
            const otherByte = other.bytes[i] & 0xff;
            if (thisByte > otherByte)
                return 1;
            if (thisByte < otherByte)
                return -1;
        }
        return 0;
    }
}
