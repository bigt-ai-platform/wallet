import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AndroidMcpClient,
  claimPairing,
  parseAndroidApps,
  parseScreenStateTsv,
} from "../src/android-client.js";

const SCREEN_TSV = [
  "note:structural-only nodes are omitted from the tree",
  "screen:1080x2400 density:420 orientation:portrait",
  "--- window:42 type:APPLICATION pkg:com.android.calculator2 title:Calculator activity:.Calculator layer:0 focused:true ---",
  "node_id\tclass\ttext\tdesc\tres_id\tbounds\tflags",
  "node_a1b2\tEditText\t\tSearch field\tcom.pkg:id/search\t100,50,500,120\ton,clk,edt,foc,ena",
  "node_c3d4\tButton\t7\t-\tcom.pkg:id/digit_7\t50,800,270,1000\ton,clk,ena",
  "hierarchy:",
  "node_a1b2",
].join("\n");

function rpcText(text: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function rpcImage(data: string, mimeType = "image/jpeg"): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data, mimeType }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Stub fetch: capture each tools/call and answer per tool name. */
function stubFetch(answers: Record<string, () => Response>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method !== "tools/call") return rpcText("{}");
      const name = body.params.name;
      calls.push({ name, args: body.params.arguments });
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected tool ${name}`);
      return answer();
    }),
  );
  return calls;
}

const CFG = { device: "self", baseUrl: "http://127.0.0.1:8080", token: "tok" };

describe("android-remote-control-mcp parsers", () => {
  it("parses the compact TSV screen state", () => {
    const parsed = parseScreenStateTsv(SCREEN_TSV);
    expect(parsed.width).toBe(1080);
    expect(parsed.height).toBe(2400);
    expect(parsed.foreground).toBe("com.android.calculator2");
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.elements[0]).toMatchObject({
      ref: "node_a1b2",
      role: "EditText",
      label: "Search field",
      viewId: "com.pkg:id/search",
      editable: true,
      focusable: true,
      coordinates: { x: 300, y: 85 },
    });
    expect(parsed.elements[1]).toMatchObject({ ref: "node_c3d4", text: "7", clickable: true, editable: false });
  });

  it("parses the JSON app list", () => {
    expect(
      parseAndroidApps('[{"package_id":"com.example.app","name":"Example App","is_system":false}]'),
    ).toEqual([{ id: "com.example.app", name: "Example App" }]);
  });
});

describe("AndroidMcpClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists apps via android_list_apps", async () => {
    stubFetch({ android_list_apps: () => rpcText('[{"package_id":"com.tencent.mm","name":"WeChat"}]') });
    const client = await AndroidMcpClient.connect(CFG);
    expect(await client.listApps()).toEqual([{ id: "com.tencent.mm", name: "WeChat" }]);
  });

  it("launches/terminates with package_id", async () => {
    const calls = stubFetch({
      android_open_app: () => rpcText("ok"),
      android_close_app: () => rpcText("ok"),
    });
    const client = await AndroidMcpClient.connect(CFG);
    await client.launchApp("com.tencent.mm");
    await client.terminateApp("com.tencent.mm");
    expect(calls).toEqual([
      { name: "android_open_app", args: { package_id: "com.tencent.mm" } },
      { name: "android_close_app", args: { package_id: "com.tencent.mm" } },
    ]);
  });

  it("reads screen elements and the foreground app from android_get_screen_state", async () => {
    stubFetch({ android_get_screen_state: () => rpcText(SCREEN_TSV) });
    const client = await AndroidMcpClient.connect(CFG);
    const els = await client.listElements();
    expect(els.map((e) => e.ref)).toEqual(["node_a1b2", "node_c3d4"]);
    expect(await client.foregroundApp()).toBe("com.android.calculator2");
  });

  it("types into the focused editable node (and submits)", async () => {
    const calls = stubFetch({
      android_get_screen_state: () => rpcText(SCREEN_TSV),
      android_type_append_text: () => rpcText("typed"),
      android_press_key: () => rpcText("pressed"),
    });
    const client = await AndroidMcpClient.connect(CFG);
    await client.typeKeys("hello", true);
    expect(calls).toEqual([
      { name: "android_get_screen_state", args: { include_screenshot: false } },
      { name: "android_type_append_text", args: { node_id: "node_a1b2", text: "hello" } },
      { name: "android_press_key", args: { key: "ENTER" } },
    ]);
  });

  it("swipes with computed coordinates", async () => {
    const calls = stubFetch({
      android_get_screen_state: () => rpcText(SCREEN_TSV),
      android_swipe: () => rpcText("swiped"),
    });
    const client = await AndroidMcpClient.connect(CFG);
    await client.swipe("up");
    const swipe = calls.find((c) => c.name === "android_swipe");
    expect(swipe?.args).toEqual({ x1: 540, y1: 1362, x2: 540, y2: 1038, duration: 300 });
  });

  it("taps by ref (tap_node) or coordinates (tap)", async () => {
    const calls = stubFetch({
      android_tap_node: () => rpcText("ok"),
      android_tap: () => rpcText("ok"),
    });
    const client = await AndroidMcpClient.connect(CFG);
    await client.tap({ ref: "node_a1b2" });
    await client.tap({ x: 100, y: 200 });
    expect(calls).toEqual([
      { name: "android_tap_node", args: { node_id: "node_a1b2" } },
      { name: "android_tap", args: { x: 100, y: 200 } },
    ]);
  });

  it("maps buttons, opens URLs, and takes screenshots", async () => {
    const calls = stubFetch({
      android_press_home: () => rpcText("ok"),
      android_open_uri: () => rpcText("ok"),
      android_get_screen_state: () => rpcImage("aGVsbG8="),
    });
    const client = await AndroidMcpClient.connect(CFG);
    await client.pressButton("HOME");
    await client.openUrl("https://example.com");
    expect(await client.screenshotDataUri()).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(calls.map((c) => c.name)).toEqual(["android_press_home", "android_open_uri", "android_get_screen_state"]);
  });

  it("honors a device-slug tool prefix", async () => {
    const calls = stubFetch({ android_pixel7_open_app: () => rpcText("ok") });
    const client = await AndroidMcpClient.connect({ ...CFG, toolPrefix: "android_pixel7_" });
    await client.launchApp("com.example");
    expect(calls[0].name).toBe("android_pixel7_open_app");
  });

  it("synthesizes a single-device list", async () => {
    const client = await AndroidMcpClient.connect(CFG);
    expect(await client.listDevices()).toEqual([
      { id: "self", platform: "android", type: "real", state: "online" },
    ]);
  });
});

describe("claimPairing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("spends a short code for a per-device token", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ token: "tok", device_id: "pd-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const claimed = await claimPairing("http://127.0.0.1:8080/", "ABCD1234", { name: "wallet" });

    expect(claimed).toEqual({ baseUrl: "http://127.0.0.1:8080", token: "tok", deviceId: "pd-1" });
    expect(calls[0].url).toBe("http://127.0.0.1:8080/pair/claim");
    expect(calls[0].body).toEqual({ code: "ABCD1234", name: "wallet" });
  });

  it("rejects a non-2xx, and a 200 without a token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(claimPairing("http://x", "BAD")).rejects.toThrow("pair/claim: 404");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })),
    );
    await expect(claimPairing("http://x", "ABCD1234")).rejects.toThrow("no token");
  });
});
