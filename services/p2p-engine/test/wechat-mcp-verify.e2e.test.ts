import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Ed25519Key, didFromEd25519Key } from "did";
import { buildApp } from "../src/server.js";
import { MemSettlementStore } from "../src/store.js";
import { ReplayGuard, signPayload } from "../src/sign.js";

/**
 * End-to-end: a WeChat CNY P2P payment is verified by reading the buyer's own
 * WeChat bill over **MCP** (docs/p2p.md §12).
 *
 * Unlike the unit tests, this does NOT inject a fake `readDevice`. It stands up
 * a mock `android-remote-control-mcp` endpoint that speaks the real MCP
 * Streamable-HTTP dialect (`initialize` + `tools/call` for
 * `android_get_screen_state`) and serves the buyer's WeChat sending record, so
 * the engine's default reader runs the whole path:
 *
 *   POST /swaps/:id/device-read
 *     -> p2p-verify connectFromGrant
 *     -> mobile-control AndroidMcpClient (real HTTP, one JSON-RPC POST per call)
 *     -> the mock MCP endpoint (the phone)
 *     -> parseRailEntry('wechat') -> verdict -> validatePaymentVerdict
 *
 * Then the wallet-signed verdict is POSTed to /swaps/:id/verify.
 */

const seller = Ed25519Key.createNewKey();
const buyer = Ed25519Key.createNewKey();
const engine = Ed25519Key.createNewKey();
const sellerDid = didFromEd25519Key(seller);
const buyerDid = didFromEd25519Key(buyer);
const engineDid = didFromEd25519Key(engine);

const TX_ID = "4200001234567890";
const REMARK = "p2p-9f3a";

// Device-local wall clock: the order is created earlier in the day than the
// payment shown on the WeChat bill, and the engine reads it afterwards — so the
// entry lands inside the swap window [first event, now].
const T_ORDER = new Date(2026, 9, 13, 14, 30, 0).getTime();
const T_READ = new Date(2026, 9, 13, 14, 35, 0).getTime();
let clock = T_ORDER;

const store = new MemSettlementStore();

function signed(key: Ed25519Key, did: string, fields: Record<string, unknown>) {
  const payload = { ...fields, did, nonce: randomBytes(8).toString("hex"), timestamp: clock };
  return { ...payload, signature: signPayload(payload, key.getPrivHex()!) };
}
const bump = () => {
  clock += 1;
};
type TestApp = Awaited<ReturnType<typeof buildApp>>;

/**
 * The WeChat bill detail the buyer's phone shows, as
 * `android_get_screen_state`'s compact TSV: screen header, the focused window,
 * then `node_id\tclass\ttext\tdesc\tres_id\tbounds\tflags` rows. It carries the
 * same facts the extractor expects (§12): exact amount, counterparty, 到账时间,
 * 备注, 微信支付交易单号, and 支付成功.
 */
function wechatScreenTsv(): string {
  const rows = [
    ["node_b1", "TextView", "¥715.00", "-", "-", "40,600,1040,660", "on"],
    ["node_b2", "TextView", "转账收款方 张三", "-", "-", "40,700,1040,760", "on"],
    ["node_b3", "TextView", "到账时间 2026-10-13 14:32", "-", "-", "40,800,1040,860", "on"],
    ["node_b4", "TextView", `备注 ${REMARK}`, "-", "-", "40,900,1040,960", "on"],
    ["node_b5", "TextView", `微信支付交易单号 ${TX_ID}`, "-", "-", "40,1000,1040,1060", "on"],
    ["node_b6", "TextView", "支付成功", "-", "-", "40,1100,1040,1160", "on"],
  ];
  return [
    "screen:1080x2400 density:440 orientation:portrait",
    "--- window:1 type:APPLICATION pkg:com.tencent.mm focused:true ---",
    ...rows.map((r) => r.join("\t")),
  ].join("\n");
}

const SHOT_B64 = Buffer.from("fake-wechat-screenshot-bytes").toString("base64");

/** When set, the mock endpoint serves this TSV instead of the good bill (test seam). */
let screenOverride: string | undefined;

/** One JSON-RPC answer from the mock android-mcp endpoint. */
function handleRpc(method: string, id: unknown, params: Record<string, unknown>): unknown {
  if (method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-android-mcp", version: "1.0.0" } };
  }
  if (method === "tools/list") {
    return { tools: [{ name: "android_get_screen_state", inputSchema: { type: "object" } }] };
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name.endsWith("get_screen_state")) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: screenOverride ?? wechatScreenTsv() }];
      if (args.include_screenshot === true) {
        content.push({ type: "image", data: SHOT_B64, mimeType: "image/jpeg" });
      }
      return { content };
    }
    if (name.endsWith("list_apps")) {
      return { content: [{ type: "text", text: JSON.stringify([{ package_id: "com.tencent.mm", name: "WeChat" }]) }] };
    }
    if (name.endsWith("notification_list")) {
      const receipt = {
        notification_id: "n1",
        package_name: "com.tencent.mm",
        app_name: "WeChat",
        title: "微信支付",
        text: `微信支付收款到账 ¥715.00 来自 张三 备注 ${REMARK} 交易单号 ${TX_ID}`,
        big_text: null,
        sub_text: null,
        timestamp: new Date(2026, 9, 13, 14, 32, 0).getTime(),
        is_ongoing: false,
        is_clearable: true,
      };
      return { content: [{ type: "text", text: `CAUTION: untrusted external content.\n${JSON.stringify({ notifications: [receipt] })}` }] };
    }
    throw { code: -32601, message: `unknown tool ${name}` };
  }
  throw { code: -32601, message: `unknown method ${method}` };
}

let mockMcp: Server;
let mockMcpUrl: string;
/** The tool names the mock MCP endpoint was asked to run. */
const mcpCalls: string[] = [];

beforeAll(async () => {
  mockMcp = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let reply: { jsonrpc: string; id: unknown; result?: unknown; error?: unknown };
      try {
        const msg = JSON.parse(raw) as { id: unknown; method: string; params?: Record<string, unknown> };
        if (msg.method === "tools/call") mcpCalls.push(String((msg.params as { name?: string }).name ?? ""));
        reply = { jsonrpc: "2.0", id: msg.id, result: handleRpc(msg.method, msg.id, msg.params ?? {}) };
      } catch (e) {
        reply = { jsonrpc: "2.0", id: null, error: e };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => mockMcp.listen(0, "127.0.0.1", resolve));
  const addr = mockMcp.address();
  if (!addr || typeof addr === "string") throw new Error("mock MCP did not bind");
  mockMcpUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockMcp.close(() => resolve()));
});

beforeEach(() => {
  clock = T_ORDER;
  mcpCalls.length = 0;
  screenOverride = undefined;
  store.orders.clear();
  store.swapEvents.clear();
  store.paymentProfiles.clear();
  store.paymentProofs.clear();
  store.paymentVerifications.clear();
  store.pairings.clear();
});

/** Engine with the REAL default device reader (no injected fake). */
async function app(extraEnv: NodeJS.ProcessEnv = {}): Promise<TestApp> {
  return buildApp({
    store,
    env: {
      SETTLEMENT_ENGINE_DID: engineDid,
      SETTLEMENT_ADMIN_TOKEN: "adm",
      ...extraEnv,
    } as NodeJS.ProcessEnv,
    guard: new ReplayGuard(() => clock),
    chain: null,
    now: () => clock,
    anchor: async () => ({ txid: "a".repeat(64) }),
  });
}

/** Seller lists USDT for CNY 715 over WeChat; the buyer matches and escrows. */
async function toEscrowLocked(a: TestApp): Promise<string> {
  const r1 = await a.inject({
    method: "POST",
    url: "/orders",
    payload: signed(seller, sellerDid, {
      type: "limit_sell",
      sellerDid,
      giveToken: "USDT",
      giveAmount: "100",
      giveChain: "L0",
      wantCurrency: "CNY",
      wantAmount: "715",
      wantRail: "wechat",
      validUntil: Math.floor(clock / 1000) + 3600,
    }),
  });
  expect(r1.statusCode).toBe(201);
  bump();
  const r2 = await a.inject({
    method: "POST",
    url: `/orders/${r1.json().orderId}/match`,
    payload: signed(buyer, buyerDid, { buyerDid, receiveAddress: "1Receive" }),
  });
  expect(r2.statusCode).toBe(201);
  const swapId = r2.json().swapId as string;
  bump();
  const lock = await a.inject({
    method: "POST",
    url: `/swaps/${swapId}/transitions`,
    payload: signed(seller, sellerDid, { action: "escrow_lock", txHash: "f".repeat(64) }),
  });
  expect(lock.statusCode).toBe(200);
  bump();
  return swapId;
}

/** DID-signed grant pointing at the mock MCP endpoint (the "phone"). */
async function pair(a: TestApp, key: Ed25519Key, did: string, swapId: string): Promise<string> {
  const pairingId = `pr-${randomBytes(12).toString("hex")}`;
  const r = await a.inject({
    method: "POST",
    url: "/pairings",
    payload: signed(key, did, {
      pairingId,
      endpoint: mockMcpUrl,
      deviceId: "self",
      token: "tok_" + randomBytes(4).toString("hex"),
      swapId,
      issuedAt: clock,
      expiresAt: clock + 24 * 60 * 60 * 1000,
    }),
  });
  expect(r.statusCode).toBe(201);
  return pairingId;
}

describe("WeChat CNY p2p payment verified over MCP (docs/p2p.md §12)", () => {
  it("reads the buyer's WeChat bill through the MCP endpoint and verifies the swap", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const pairingId = await pair(a, buyer, buyerDid, swapId);

    // The buyer paid at 14:32; the engine reads at 14:35.
    clock = T_READ;
    const read = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/device-read`,
      payload: signed(buyer, buyerDid, { pairingId }),
    });

    // The read went through MCP: the mock endpoint served android_get_screen_state.
    expect(mcpCalls.length).toBeGreaterThan(0);
    expect(mcpCalls.every((n) => n.endsWith("get_screen_state"))).toBe(true);

    expect(read.statusCode).toBe(200);
    const body = read.json() as { side: string; verdict: Record<string, unknown>; check: { ok: boolean } };
    expect(body.side).toBe("buyer");
    expect(body.check.ok).toBe(true);
    expect(body.verdict).toMatchObject({
      side: "buyer",
      observed: "sent",
      evidenceKind: "device_read",
      txId: TX_ID,
      amount: "715.00",
      remark: REMARK,
    });
    expect(new Date(body.verdict.paidAt as number).toISOString()).toBe(new Date(2026, 9, 13, 14, 32).toISOString());
  });

  it("a screenshot capture hash is included, and the wallet-signed verdict is accepted by /verify", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const pairingId = await pair(a, buyer, buyerDid, swapId);
    clock = T_READ;

    const read = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/device-read`,
      payload: signed(buyer, buyerDid, { pairingId }),
    });
    expect(read.statusCode).toBe(200);
    const verdict = read.json().verdict as Record<string, unknown>;

    // The verdict carries the capture sha256 the wallet signs (bytes stay on the device).
    const expectedCapture = createHash("sha256").update(Buffer.from("fake-wechat-screenshot-bytes")).digest("hex");
    expect(verdict.captures).toEqual([expectedCapture]);

    // The wallet signs exactly the verdict the read produced, per §12.
    const verify = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/verify`,
      payload: signed(buyer, buyerDid, {
        side: verdict.side,
        observed: verdict.observed,
        evidenceKind: verdict.evidenceKind,
        txId: verdict.txId,
        amount: verdict.amount,
        remark: verdict.remark,
        paidAt: verdict.paidAt,
        captures: verdict.captures,
      }),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ stored: true, side: "buyer" });
  });

  it("a tampered bill (wrong amount) is read through MCP but rejected by the check", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const pairingId = await pair(a, buyer, buyerDid, swapId);
    clock = T_READ;

    // The phone shows a bill whose amount does not match the swap's 715.
    screenOverride = wechatScreenTsv().replace("¥715.00", "¥999.00");
    const read = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/device-read`,
      payload: signed(buyer, buyerDid, { pairingId }),
    });

    // The read succeeds over MCP, but the check flags the amount mismatch.
    expect(read.statusCode).toBe(200);
    expect((read.json() as { check: { ok: boolean } }).check.ok).toBe(false);
    expect(mcpCalls.length).toBeGreaterThan(0);
  });

  it("reads the seller's WeChat 收款到账 notification when the window is hidden (via=notification)", async () => {
    const a = await app();
    const swapId = await toEscrowLocked(a);
    const pairingId = await pair(a, seller, sellerDid, swapId);
    clock = T_READ;

    const read = await a.inject({
      method: "POST",
      url: `/swaps/${swapId}/device-read`,
      payload: signed(seller, sellerDid, { pairingId, via: "notification" }),
    });

    expect(read.statusCode).toBe(200);
    const body = read.json() as { side: string; verdict: Record<string, unknown>; check: { ok: boolean } };
    expect(body.side).toBe("seller");
    expect(body.check.ok).toBe(true);
    expect(body.verdict).toMatchObject({
      side: "seller",
      observed: "received",
      txId: TX_ID,
      amount: "715.00",
      remark: REMARK,
      counterpartyName: "张三",
    });
  });
});
