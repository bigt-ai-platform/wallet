import { afterEach, describe, expect, test, vi } from "vitest";
import { OkHttp3Util, type BinaryTransportRequest } from "../../src/net/bigtangle/utils/OkHttp3Util";

/**
 * The Firebase/Capacitor Android app installs a byte-exact transport (see
 * expo-app/sources/services/binaryPost.ts). These tests pin the hook the app
 * relies on: the transaction bytes handed to `post()` must reach the transport
 * unchanged, and the transport's status/body must be used for error handling.
 */
describe("OkHttp3Util transport", () => {
  afterEach(() => {
    OkHttp3Util.setTransport(null);
  });

  test("hands the exact bytes to the installed transport", async () => {
    const bytes = new Uint8Array([0x01, 0x80, 0xff, 0x00, 0x42, 0x9e]);
    const seen: BinaryTransportRequest[] = [];
    OkHttp3Util.setTransport(async (request) => {
      seen.push(request);
      return { status: 200, data: new TextEncoder().encode('{"errorcode":0}') };
    });

    const body = await OkHttp3Util.post("https://node.example/submitTransaction", bytes);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://node.example/submitTransaction");
    expect(Array.from(seen[0].data)).toEqual(Array.from(bytes));
    expect(seen[0].headers["Content-Type"]).toContain("application/octet-stream");
    expect(body).toBe('{"errorcode":0}');
  });

  test("surfaces the transport's HTTP status as an error", async () => {
    OkHttp3Util.setTransport(async () => ({
      status: 500,
      data: new TextEncoder().encode("boom"),
    }));

    await expect(OkHttp3Util.post("https://node.example/saveBlock", new Uint8Array([1]))).rejects.toThrow(
      "HTTP Error: 500"
    );
  });

  test("surfaces the node errorcode from the transport body", async () => {
    OkHttp3Util.setTransport(async () => ({
      status: 200,
      data: new TextEncoder().encode('{"errorcode":7,"message":"bad tx"}'),
    }));

    await expect(OkHttp3Util.post("https://node.example/saveBlock", new Uint8Array([1]))).rejects.toThrow(
      "bad tx"
    );
  });

  test("falls back to axios when the transport is cleared", async () => {
    const transport = vi.fn();
    OkHttp3Util.setTransport(transport);
    OkHttp3Util.setTransport(null);

    // No server to talk to: the axios path fails differently than the
    // transport (which was never called).
    await expect(OkHttp3Util.post("http://127.0.0.1:1/submitTransaction", new Uint8Array([1]))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
