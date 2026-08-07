import { KeyValue } from "./KeyValue";
import { Utils } from "./Utils";
import { UnsafeByteArrayOutputStream } from "./UnsafeByteArrayOutputStream";
import { DataInputStream } from "../utils/DataInputStream";

/*
 * help to set memo string as key value list
 */
export class MemoInfo {
  public static readonly MEMO = "memo";
  public static readonly ENCRYPT = "SignedData";

  private kv: KeyValue[] | null = null;

  constructor(memo?: string) {
    if (memo) {
      this.kv = [];
      const keyValue = new KeyValue();
      keyValue.setKey(MemoInfo.MEMO);
      keyValue.setValue(memo);
      this.kv.push(keyValue);
    }
  }

  /*
   * add ENCRYPT data as key value
   */
  public addEncryptMemo(memo: string): void {
    if (this.kv === null) {
      this.kv = [];
    }

    const keyValue = new KeyValue();
    keyValue.setKey(MemoInfo.ENCRYPT);
    keyValue.setValue(memo);
    this.kv.push(keyValue);
  }

  public toByteArray(): Uint8Array {
    const dos = new UnsafeByteArrayOutputStream();
    const list = this.kv;
    if (list === null) {
      dos.writeInt(0);
    } else {
      dos.writeInt(list.length);
      for (const kv of list) {
        const bytes = kv.toByteArray();
        dos.writeInt(bytes.length);
        dos.writeBytes(new Uint8Array(bytes), 0, bytes.length);
      }
    }
    dos.close();
    return dos.toByteArray();
  }

  public static parseBytes(buf: Uint8Array | null): MemoInfo | null {
    if (buf === null || buf === undefined || buf.length === 0) return null;
    const m = new MemoInfo();
    const dis = new DataInputStream(new Uint8Array(buf));
    const size = dis.readInt();
    m.kv = [];
    for (let i = 0; i < size; i++) {
      const len = dis.readInt();
      const bytes = dis.readBytes(len);
      m.kv.push(new KeyValue().parse(bytes));
    }
    dis.close();
    return m;
  }

  /** Parse from a String - tries hex-encoded binary first, then legacy JSON. */
  public static parse(str: string | Uint8Array | null): MemoInfo | null {
    if (str === null) return null;
    if (str instanceof Uint8Array) return MemoInfo.parseBytes(str);
    // Try hex-encoded binary first
    try {
      const buf = Utils.HEX.decode(str);
      return MemoInfo.parseBytes(buf);
    } catch (e: any) {
      // Fallback to legacy JSON
      return MemoInfo.fromJson(str);
    }
  }

  public toJson(): string {
    return JSON.stringify(this);
  }

  public static fromJson(jsonStr: string | null): MemoInfo | null {
    if (jsonStr === null) return null;
    try {
      const parsed = JSON.parse(jsonStr);
      const m = new MemoInfo();
      if (parsed.kv !== undefined && parsed.kv !== null) {
        m.kv = parsed.kv.map((item: any) => {
          const kv = new KeyValue();
          kv.setKey(item.key !== undefined ? item.key : null);
          kv.setValue(item.value !== undefined ? item.value : null);
          return kv;
        });
      }
      return m;
    } catch (e: any) {
      throw new Error(e);
    }
  }

  /*
   * used for display the memo and cutoff maximal to 20 chars
   */
  public static parseToString(str: string | null): string | null {
    try {
      if (str === null) return null;
      const buf = Utils.HEX.decode(str);
      const m = MemoInfo.parseBytes(buf);
      if (m === null) return null;
      let s = "";
      if (m.getKv()) {
        for (const keyvalue of m.getKv()!) {
          if (
            MemoInfo.valueDisplay(keyvalue) !== null &&
            keyvalue.getKey() !== null &&
            keyvalue.getKey() !== "null" &&
            keyvalue.getKey().length > 0
          ) {
            s += `${keyvalue.getKey()}: ${MemoInfo.valueDisplay(keyvalue)} \n`;
          }
        }
      }
      return s;
    } catch (e: any) {
      // Fallback: try parsing as legacy JSON
      try {
        return MemoInfo.parseToStringJson(str);
      } catch (e2: any) {
        return str;
      }
    }
  }

  private static parseToStringJson(jsonStr: string | null): string | null {
    if (jsonStr === null) return null;
    try {
      const m = MemoInfo.fromJson(jsonStr);
      let s = "";
      if (m && m.getKv()) {
        for (const keyvalue of m.getKv()!) {
          if (
            MemoInfo.valueDisplay(keyvalue) !== null &&
            keyvalue.getKey() !== null &&
            keyvalue.getKey() !== "null" &&
            keyvalue.getKey().length > 0
          ) {
            s += `${keyvalue.getKey()}: ${MemoInfo.valueDisplay(keyvalue)} \n`;
          }
        }
      }
      return s;
    } catch (e: any) {
      return jsonStr;
    }
  }

  private static valueDisplay(keyvalue: KeyValue): string | null {
    if (keyvalue.getValue() === null) {
      return "";
    }
    if (keyvalue.getValue().length < 40) {
      return keyvalue.getValue();
    } else {
      return keyvalue.getValue().substring(0, 40) + "...";
    }
  }

  public getKv(): KeyValue[] | null {
    return this.kv;
  }

  public setKv(kv: KeyValue[] | null): void {
    this.kv = kv;
  }
}
