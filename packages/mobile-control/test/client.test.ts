import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  HttpMobileClient,
  base64ToBytes,
  canonicalJson,
  parseAppsText,
  parseDevicesText,
  type HttpMobileClientOptions,
} from "../src/client.js";
import { authBase, didAuthHeaders, ed25519Signer } from "../src/node.js";

function rpcText(text: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const CFG: HttpMobileClientOptions = { device: "emulator-5554", baseUrl: "http://127.0.0.1:8787", token: "tok" };

describe("mobile-control parsers", () => {
  it("parses the human app list and the json device list", () => {
    expect(
      parseAppsText("Found these apps on device: WeChat (com.tencent.mm), Alipay (com.eg.android.AlipayGphone)"),
    ).toEqual([
      { name: "WeChat", id: "com.tencent.mm" },
      { name: "Alipay", id: "com.eg.android.AlipayGphone" },
    ]);
    expect(parseAppsText('[{"id":"com.tencent.mm","name":"WeChat"}]')).toEqual([{ id: "com.tencent.mm", name: "WeChat" }]);
    expect(parseDevicesText('{"devices":[{"id":"emulator-5554","platform":"android","type":"emulator"}]}')).toEqual([
      { id: "emulator-5554", platform: "android", type: "emulator" },
    ]);
    expect(parseDevicesText("no devices here")).toEqual([]);
  });

  it("decodes base64 without atob or Buffer", () => {
    // "hello" → aGVsbG8=
    expect(Array.from(base64ToBytes("aGVsbG8="))).toEqual([104, 101, 108, 108, 111]);
    expect(Array.from(base64ToBytes(""))).toEqual([]);
  });

  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }], u: undefined })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});

describe("HttpMobileClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts one JSON-RPC tools/call with the bearer and returns the text", async () => {
    let seen: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
        return rpcText("Clicked on element @e5");
      }),
    );
    const client = await HttpMobileClient.connect(CFG);
    const text = await client.callToolText("mobile_click_on_screen_at_coordinates", { ref: "@e5" });
    expect(text).toBe("Clicked on element @e5");
    expect(seen.url).toBe("http://127.0.0.1:8787/mcp");
    expect(seen.body.params).toEqual({
      name: "mobile_click_on_screen_at_coordinates",
      arguments: { ref: "@e5", device: "emulator-5554" },
    });
    expect(seen.auth).toBe("Bearer tok");
  });

  it("prefers the DID header callback over the bearer", async () => {
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        auth = init.headers.Authorization;
        return rpcText("ok");
      }),
    );
    const client = await HttpMobileClient.connect({
      ...CFG,
      authHeaders: (body) => didAuthHeaders(ed25519Signer("11".repeat(32), "did:key:zS"), body, 1000),
    });
    await client.listTools();
    expect(auth).toMatch(/^DID did="did:key:zS", ts="1000", sig="[0-9a-f]+"$/);
  });

  it("extracts and decodes a screenshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = await HttpMobileClient.connect(CFG);
    expect(Array.from(await client.screenshot())).toEqual([104, 101, 108, 108, 111]);
  });

  it("surfaces a 401 as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(HttpMobileClient.connect(CFG)).rejects.toThrow(/401/);
  });
});

describe("Ed25519 request signing", () => {
  it("produces a signature the endpoint's verifier accepts", () => {
    const seed = "22".repeat(32);
    const signer = ed25519Signer(seed, "did:key:zTest");
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const header = didAuthHeaders(signer, body, 1234).Authorization;
    const m = header.match(/^DID did="([^"]+)", ts="(\d+)", sig="([0-9a-f]+)"$/)!;
    expect(m[1]).toBe("did:key:zTest");

    // Rebuild the public key from the same seed (Ed25519 PKCS8 → SPKI) and verify.
    const priv = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(seed, "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const spki = priv.export({ format: "der", type: "spki" });
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    expect(cryptoVerify(null, Buffer.from(authBase(Number(m[2]), body)), pub, Buffer.from(m[3], "hex"))).toBe(true);
  });

  it("rejects a non-32-byte seed", () => {
    expect(() => ed25519Signer("00", "did:key:z")).toThrow(/32 bytes/);
  });
});
