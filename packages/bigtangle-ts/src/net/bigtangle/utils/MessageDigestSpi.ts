// MessageDigestSpi.ts
// Translation of java.security.MessageDigestSpi

export abstract class MessageDigestSpi {
  private tempArray?: Uint8Array;

  protected engineGetDigestLength(): number {
    return 0;
  }

  protected abstract engineUpdateByte(input: number): void;

  protected abstract engineUpdateBytes(input: Uint8Array, offset: number, len: number): void;

  protected engineUpdateBuffer(input: Uint8Array): void {
    if (input.length === 0) return;

    // If we can access the array directly
    this.engineUpdateBytes(input, 0, input.length);
  }

  protected abstract engineDigest(): Uint8Array;

  protected engineDigestInto(buf: Uint8Array, offset: number, len: number): number {
    const digest = this.engineDigest();

    if (len < digest.length) {
      throw new Error("DigestException: partial digests not returned");
    }
    if (buf.length - offset < digest.length) {
      throw new Error("DigestException: insufficient space in the output buffer to store the digest");
    }

    buf.set(digest, offset);
    return digest.length;
  }

  protected abstract engineReset(): void;

  public clone(): MessageDigestSpi {
    // Shallow clone via Object.create
    const copy = Object.create(Object.getPrototypeOf(this));
    Object.assign(copy, this);

    if (this.tempArray) {
      copy.tempArray = new Uint8Array(this.tempArray);
    }

    return copy;
  }
}
