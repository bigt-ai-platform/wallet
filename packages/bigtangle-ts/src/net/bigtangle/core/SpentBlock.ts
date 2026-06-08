import { DataClass } from "./DataClass";
import { Sha256Hash } from "./Sha256Hash";
import { Utils } from "../utils/Utils";
import { DataInputStream } from "../utils/DataInputStream";
import { UnsafeByteArrayOutputStream } from "./UnsafeByteArrayOutputStream";
import { JsonProperty } from "jackson-js";

export class SpentBlock extends DataClass {
  @JsonProperty()
  private blockHash: Sha256Hash | null = null;
  @JsonProperty()
  private confirmed: boolean = false;
  @JsonProperty()
  private spent: boolean = false;
  @JsonProperty()
  private spenderBlockHash: Sha256Hash | null = null;
  @JsonProperty()
  private time: number = 0;

  public setDefault(): void {
    this.spent = false;
    this.confirmed = false;
    this.spenderBlockHash = null;
    this.time = Math.floor(Date.now() / 1000);
  }

  public getBlockHashHex(): string {
    return this.blockHash !== null
      ? Utils.HEX.encode(this.blockHash.getBytes())
      : "";
  }

  public toByteArray(): Uint8Array {
    const baos = new UnsafeByteArrayOutputStream();

    // Write superclass data
    const superBytes = new Uint8Array(super.toByteArray());
    baos.writeBytes(superBytes, 0, superBytes.length);

    // Write class-specific data
    const blockHashBytes = new Uint8Array(this.blockHash === null
      ? Sha256Hash.ZERO_HASH.getBytes()
      : this.blockHash.getBytes());
    baos.writeBytes(blockHashBytes, 0, blockHashBytes.length);
    
    baos.writeBoolean(this.confirmed);
    baos.writeBoolean(this.spent);
    
    const spenderBlockHashBytes = new Uint8Array(this.spenderBlockHash === null
      ? Sha256Hash.ZERO_HASH.getBytes()
      : this.spenderBlockHash.getBytes());
    baos.writeBytes(spenderBlockHashBytes, 0, spenderBlockHashBytes.length);
    
    baos.writeLong(this.time);

    return baos.toByteArray();
  }

  public parseDIS(dis: DataInputStream): SpentBlock {
    super.parseDIS(dis);
    this.blockHash = Sha256Hash.wrap(dis.readBytes(32));
    this.confirmed = dis.readBoolean();
    this.spent = dis.readBoolean();
    this.spenderBlockHash = Sha256Hash.wrap(dis.readBytes(32));
    if (this.spenderBlockHash?.equals(Sha256Hash.ZERO_HASH)) {
      this.spenderBlockHash = null;
    }
    this.time = dis.readLong();
    return this;
  }

  public parse(buf: Uint8Array): SpentBlock {
    const bain = new DataInputStream(new Uint8Array(buf));
    try {
      this.parseDIS(bain);
      bain.close();
    } catch (e: any) {
      throw new Error(e);
    }
    return this;
  }

  public getBlockHash(): Sha256Hash | null {
    return this.blockHash;
  }

  public setBlockHash(blockHash: Sha256Hash | null): void {
    this.blockHash = blockHash;
  }

  public isConfirmed(): boolean {
    return this.confirmed;
  }

  public setConfirmed(confirmed: boolean): void {
    this.confirmed = confirmed;
  }

  public isSpent(): boolean {
    return this.spent;
  }

  public setSpent(spent: boolean): void {
    this.spent = spent;
  }

  public getSpenderBlockHash(): Sha256Hash | null {
    return this.spenderBlockHash;
  }

  public setSpenderBlockHash(spenderBlockHash: Sha256Hash | null): void {
    this.spenderBlockHash = spenderBlockHash;
  }

  public getTime(): number {
    return this.time;
  }

  public setTime(time: number): void {
    this.time = time;
  }

  public hashCode(): number {
    let result = 17;
    result = 31 * result + (this.blockHash ? this.blockHash.hashCode() : 0);
    result = 31 * result + (this.confirmed ? 1 : 0);
    result = 31 * result + (this.spent ? 1 : 0);
    result =
      31 * result +
      (this.spenderBlockHash ? this.spenderBlockHash.hashCode() : 0);
    result = 31 * result + this.time;
    return result;
  }

  public equals(obj: any): boolean {
    if (this === obj) return true;
    if (obj == null || this.constructor !== obj.constructor) return false;
    const other = obj as SpentBlock;
    return (
      (this.blockHash === other.blockHash ||
        (this.blockHash !== null &&
          other.blockHash !== null &&
          this.blockHash.equals(other.blockHash))) &&
      this.confirmed === other.confirmed &&
      (this.spenderBlockHash === other.spenderBlockHash ||
        (this.spenderBlockHash !== null &&
          other.spenderBlockHash !== null &&
          this.spenderBlockHash.equals(other.spenderBlockHash))) &&
      this.spent === other.spent &&
      this.time === other.time
    );
  }

  public toString(): string {
    return (
      ` [blockHash=${this.blockHash}, confirmed=${this.confirmed}, spent=${this.spent}` +
      `, spenderBlockHash=${this.spenderBlockHash}, time=${this.time}]`
    );
  }
}
