export class BaseTaggableObject {
  protected tags: Map<string, Uint8Array> | null = null;

  maybeGetTag(tag: string): Uint8Array | null {
    if (this.tags == null) return null;
    const b = this.tags.get(tag);
    return b === undefined ? null : b;
  }

  getTag(tag: string): Uint8Array {
    const b = this.maybeGetTag(tag);
    if (b == null) throw new Error("Unknown tag " + tag);
    return b;
  }

  setTag(tag: string, value: Uint8Array): void {
    if (tag == null) throw new Error("tag is null");
    if (value == null) throw new Error("value is null");
    if (this.tags == null) this.tags = new Map<string, Uint8Array>();
    this.tags.set(tag, value);
  }

  getTags(): Map<string, Uint8Array> {
    return new Map<string, Uint8Array>(this.tags ?? []);
  }
}
