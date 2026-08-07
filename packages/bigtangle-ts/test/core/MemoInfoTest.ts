import { describe, test, expect } from "vitest";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Utils } from "../../src/net/bigtangle/utils/Utils";

describe("MemoInfoTest", () => {
  test("testRoundTrip", () => {
    const original = new MemoInfo("hello world");
    const bytes = original.toByteArray();
    const reparsed = MemoInfo.parseBytes(bytes);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.getKv()).not.toBeNull();
    expect(reparsed!.getKv()!.length).toBe(1);
    expect(reparsed!.getKv()![0].getKey()).toBe("memo");
    expect(reparsed!.getKv()![0].getValue()).toBe("hello world");
  });

  test("testRoundTripEncrypt", () => {
    const original = new MemoInfo("visible");
    original.addEncryptMemo("secret data");
    const bytes = original.toByteArray();
    const reparsed = MemoInfo.parseBytes(bytes);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.getKv()!.length).toBe(2);
    expect(reparsed!.getKv()![0].getKey()).toBe("memo");
    expect(reparsed!.getKv()![0].getValue()).toBe("visible");
    expect(reparsed!.getKv()![1].getKey()).toBe(MemoInfo.ENCRYPT);
    expect(reparsed!.getKv()![1].getValue()).toBe("secret data");
  });

  test("testRoundTripEmpty", () => {
    const original = new MemoInfo();
    const bytes = original.toByteArray();
    const reparsed = MemoInfo.parseBytes(bytes);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.getKv() === null || reparsed!.getKv()!.length === 0).toBe(true);
  });

  test("testNull", () => {
    expect(MemoInfo.parseBytes(null)).toBeNull();
    expect(MemoInfo.parseBytes(new Uint8Array(0))).toBeNull();
    expect(MemoInfo.parse(null)).toBeNull();
  });

  test("testDeterministic", () => {
    const a = new MemoInfo("test");
    const b = new MemoInfo("test");
    const ba = a.toByteArray();
    const bb = b.toByteArray();
    expect(ba.length).toBe(bb.length);
    for (let i = 0; i < ba.length; i++) {
      expect(ba[i]).toBe(bb[i]);
    }
  });

  test("testHexEncodeRoundTrip", () => {
    const original = new MemoInfo("via transaction");
    const hex = Utils.HEX.encode(original.toByteArray());
    const decoded = Utils.HEX.decode(hex);
    const reparsed = MemoInfo.parseBytes(decoded);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.getKv()!.length).toBe(1);
    expect(reparsed!.getKv()![0].getValue()).toBe("via transaction");
  });

  test("testParseToStringDisplay", () => {
    const memo = new MemoInfo("display test");
    const hex = Utils.HEX.encode(memo.toByteArray());
    const display = MemoInfo.parseToString(hex);
    expect(display).not.toBeNull();
    expect(display).toContain("display test");
  });

  test("testParseToStringNull", () => {
    expect(MemoInfo.parseToString(null)).toBeNull();
  });

  test("testToJsonBackwardCompat", () => {
    const memo = new MemoInfo("legacy");
    const json = memo.toJson();
    expect(json).not.toBeNull();
    expect(json).toContain("legacy");
  });

  test("testFromJsonBackwardCompat", () => {
    const json = '{"kv":[{"key":"memo","value":"legacy data"}]}';
    const memo = MemoInfo.fromJson(json);
    expect(memo).not.toBeNull();
    expect(memo!.getKv()![0].getValue()).toBe("legacy data");
  });

  test("testParseToStringJsonFallback", () => {
    const json = '{"kv":[{"key":"memo","value":"legacy display"}]}';
    const display = MemoInfo.parseToString(json);
    expect(display).not.toBeNull();
    expect(display).toContain("legacy display");
  });
});
