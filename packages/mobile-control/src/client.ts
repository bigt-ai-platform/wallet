/**
 * General device control over a user-paired **mobile-mcp** endpoint
 * (docs/p2p.md §12).
 *
 * mobile-mcp (Mobile Next) is an MCP server that drives a phone over adb:
 * `mobile_list_available_devices`, `mobile_list_apps`, `mobile_launch_app`,
 * `mobile_list_elements_on_screen`, `mobile_click_on_screen_at_coordinates`,
 * `mobile_type_keys`, `mobile_swipe_on_screen`, `mobile_press_button`,
 * `mobile_open_url`, `mobile_take_screenshot`. This module is the **general**
 * client for that surface — the p2p payment-verification worker is one consumer,
 * the wallet's device screen is another.
 *
 * This file is environment-neutral (no Node built-ins): it uses the global
 * `fetch` and a pure base64 decoder, so it bundles into the React Native /
 * web wallet app. The stdio transport and the Ed25519 DID signer live in
 * `./node.js` (Node-only). Consent is the pairing: the caller only ever talks
 * to the endpoint the user handed it, and the endpoint is revocable.
 */

/** A connected device, as mobile-mcp reports it. */
export interface MobileDevice {
  id: string;
  name?: string;
  platform?: string;
  type?: string;
  state?: string;
}

/** An installed app, as `mobile_list_apps` reports it. */
export interface DeviceApp {
  /** Package/bundle id used by `launchApp`. */
  id: string;
  name: string;
}

/** One accessibility node, as an on-screen element list reports it. */
export interface UiElement {
  text?: string;
  label?: string;
  value?: string;
  role?: string;
  /** Element ref usable with `tap({ ref })`: mobile-mcp `@e5`, or a node id. */
  ref?: string;
  coordinates?: { x: number; y: number };
  /** Resource id (android-remote-control-mcp `res_id`), when reported. */
  viewId?: string;
  /** android-remote-control-mcp flags, when reported. */
  clickable?: boolean;
  editable?: boolean;
  focusable?: boolean;
  /** Bounds `[x1,y1,x2,y2]`, when reported. */
  bounds?: [number, number, number, number];
}

/** Produces the Authorization header(s) for one request body (DID auth, Node-side). */
export type AuthHeaderFn = (body: unknown) => Record<string, string>;

/** One system notification, as `notification_list` reports it (docs/p2p.md §12). */
export interface DeviceNotification {
  id?: string;
  /** Source app package (e.g. `com.tencent.mm`, `com.eg.android.AlipayGphone`). */
  packageName: string;
  appName?: string;
  title?: string;
  text?: string;
  bigText?: string;
  subText?: string;
  /** When the notification was posted (unix ms), as the device reports it. */
  timestampMs?: number;
  isOngoing?: boolean;
  isClearable?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Canonical JSON: sorted keys, no whitespace — the server recomputes this. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `mobile_list_apps` answers a human string ("Name (pkg), …") or json — accept both. */
export function parseAppsText(text: string): DeviceApp[] {
  try {
    return JSON.parse(text) as DeviceApp[];
  } catch {
    const apps: DeviceApp[] = [];
    const body = text.replace(/^Found these apps on device:\s*/, "");
    for (const m of body.matchAll(/([^(,]+?)\s*\(([^()]+)\)/g)) {
      apps.push({ name: m[1].trim(), id: m[2].trim() });
    }
    return apps;
  }
}

/** `mobile_list_available_devices` answers `{"devices":[…]}` (with an optional hint). */
export function parseDevicesText(text: string): MobileDevice[] {
  try {
    const parsed = JSON.parse(text) as { devices?: MobileDevice[] } | MobileDevice[];
    return Array.isArray(parsed) ? parsed : (parsed.devices ?? []);
  } catch {
    return [];
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Pure base64 → bytes (no `atob`, no `Buffer`) so RN/web can decode a screenshot. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** The device actions the general client exposes. */
export interface DeviceGateway {
  listApps(): Promise<DeviceApp[]>;
  launchApp(appId: string): Promise<void>;
  listElements(): Promise<UiElement[]>;
  typeKeys(text: string, submit?: boolean): Promise<void>;
  swipe(direction: "up" | "down" | "left" | "right"): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  /** Control-plane extras; test fakes need not implement them. */
  listDevices?(): Promise<MobileDevice[]>;
  /**
   * Read the system notification shade (android-remote-control-mcp only). The
   * payee's "收款到账" push is the one on-device signal WeChat does not hide
   * from the accessibility tree (docs/p2p.md §12).
   */
  listNotifications?(): Promise<DeviceNotification[]>;
  close?(): void;
}

/**
 * Shared implementation of the curated tools in terms of one JSON-RPC caller.
 * Subclasses only supply `request` (and, for stdio, process lifecycle).
 */
export abstract class BaseMobileClient implements DeviceGateway {
  protected constructor(
    protected readonly device: string,
    protected readonly timeoutMs: number = 60_000,
  ) {}

  /** Send a JSON-RPC request and resolve with its `result`. */
  protected abstract request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;

  /**
   * Raw JSON-RPC — for dialect clients that do not map onto mobile-mcp's
   * `mobile_*` tools (e.g. the android-remote-control-mcp `android_*` surface).
   */
  rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request(method, params, timeoutMs);
  }

  /** tools/call → the first text block. The device id is injected into every call. */
  async callToolText(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    const result = await this.request(
      "tools/call",
      { name, arguments: { device: this.device, ...args } },
      timeoutMs,
    );
    const blocks = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    const text = blocks.find((b) => b.type === "text")?.text;
    if (text === undefined) throw new Error(`${name}: no text content in tool result`);
    return text;
  }

  /** tools/list — capability check (also proves the handshake works). */
  async listTools(): Promise<string[]> {
    const result = (await this.request("tools/list", {})) as { tools?: Array<{ name: string }> };
    return (result?.tools ?? []).map((t) => t.name);
  }

  /** mobile_list_available_devices — the devices the user may pair/control. */
  async listDevices(): Promise<MobileDevice[]> {
    return parseDevicesText(await this.callToolText("mobile_list_available_devices", {}, 30_000));
  }

  async listApps(): Promise<DeviceApp[]> {
    return parseAppsText(await this.callToolText("mobile_list_apps", {}));
  }

  async launchApp(appId: string): Promise<void> {
    await this.callToolText("mobile_launch_app", { packageName: appId });
  }

  async terminateApp(appId: string): Promise<void> {
    await this.callToolText("mobile_terminate_app", { packageName: appId });
  }

  /** The package currently in the foreground. */
  async foregroundApp(): Promise<string> {
    return (await this.callToolText("mobile_get_foreground_app", {}, 30_000)).trim();
  }

  async listElements(): Promise<UiElement[]> {
    const text = await this.callToolText("mobile_list_elements_on_screen", { format: "json" });
    // mobile-mcp wraps the json array: "Found these elements on screen: [...]"
    return JSON.parse(text.replace(/^Found these elements on screen:\s*/, "")) as UiElement[];
  }

  async typeKeys(text: string, submit?: boolean): Promise<void> {
    await this.callToolText("mobile_type_keys", { text, ...(submit ? { submit: true } : {}) });
  }

  async swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
    await this.callToolText("mobile_swipe_on_screen", { direction });
  }

  /** Tap by element ref (preferred) or x/y coordinates. */
  async tap(target: { ref?: string; x?: number; y?: number }): Promise<void> {
    await this.callToolText("mobile_click_on_screen_at_coordinates", target);
  }

  async pressButton(button: string): Promise<void> {
    await this.callToolText("mobile_press_button", { button });
  }

  async openUrl(url: string): Promise<void> {
    await this.callToolText("mobile_open_url", { url });
  }

  async screenshot(): Promise<Uint8Array> {
    const result = await this.request("tools/call", {
      name: "mobile_take_screenshot",
      arguments: { device: this.device },
    });
    const blocks = (result as { content?: Array<{ type: string; data?: string }> } | undefined)?.content ?? [];
    const image = blocks.find((b) => b.type === "image" && b.data);
    if (!image?.data) throw new Error("mobile_take_screenshot: no image in tool result");
    return base64ToBytes(image.data);
  }

  /** The screenshot as a base64 data URI, ready to render in an `<img>`. */
  async screenshotDataUri(): Promise<string> {
    const result = await this.request("tools/call", {
      name: "mobile_take_screenshot",
      arguments: { device: this.device },
    });
    const blocks =
      (result as { content?: Array<{ type: string; data?: string; mimeType?: string }> } | undefined)?.content ?? [];
    const image = blocks.find((b) => b.type === "image" && b.data);
    if (!image?.data) throw new Error("mobile_take_screenshot: no image in tool result");
    return `data:${image.mimeType ?? "image/png"};base64,${image.data}`;
  }

  /** Subclasses with a child process override this to tear it down. */
  close(): void {}
}

export interface HttpMobileClientOptions {
  /** Device identifier as mobile-mcp reports it (mobile_list_available_devices). */
  device: string;
  /** Base URL of a mobile-mcp started with `--listen`, e.g. http://192.168.178.71:8787 */
  baseUrl: string;
  /** The server's `MOBILEMCP_AUTH` bearer token. Omit only if the server runs unauthenticated. */
  token?: string;
  /** DID request signing (`MOBILEMCP_AUTH_DIDS`) — preferred over a bare bearer. */
  authHeaders?: AuthHeaderFn;
  /** Per-request timeout in ms (default 60s — screenshot on a real device is the slow call). */
  timeoutMs?: number;
  /** Transport override (a server passes an SSRF-guarded fetch). */
  fetchImpl?: typeof fetch;
}

/** Parse a Streamable HTTP MCP response body into the JSON-RPC message. */
export function parseHttpBody(body: string, contentType: string): JsonRpcResponse {
  // The SDK answers with text/event-stream framing: "event: message\ndata: {...}"
  if (contentType.includes("text/event-stream")) {
    const dataLine = body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error("mcp http: no data line in event stream");
    return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv4InRange(ip: number, net: string, bits: number): boolean {
  const n = ipv4ToInt(net);
  if (n === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (n & mask);
}

/** Loopback / RFC1918 / link-local / unique-local hosts — the user's own phone or its LAN. */
function isLocalOrPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = ipv4ToInt(host);
  if (v4 !== null) {
    return (
      ipv4InRange(v4, "127.0.0.0", 8) ||
      ipv4InRange(v4, "10.0.0.0", 8) ||
      ipv4InRange(v4, "172.16.0.0", 12) ||
      ipv4InRange(v4, "192.168.0.0", 16) ||
      ipv4InRange(v4, "169.254.0.0", 16)
    );
  }
  if (host.includes(":")) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  }
  return false;
}

/**
 * Validate a mobile endpoint base URL before a credential is sent.
 *
 * The paired token drives the whole phone, so cleartext `http` is allowed only for loopback and
 * private-LAN hosts (the documented `http://127.0.0.1:8080` / `http://192.168.x.x:8787` pairing);
 * any other host must use `https`. Rejects non-http(s) schemes and embedded credentials.
 * Returns the trimmed base URL (no trailing slash).
 */
export function assertSecureBaseUrl(raw: string): string {
  const base = String(raw ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`invalid endpoint URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`endpoint must use http or https: ${raw}`);
  }
  if (url.username || url.password) throw new Error("endpoint must not embed credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && !isLocalOrPrivateHost(host)) {
    throw new Error(
      `refusing to send the pairing credential over cleartext http to ${host} — use https or a loopback/LAN address`,
    );
  }
  return base;
}

/**
 * MCP client over mobile-mcp's Streamable HTTP transport (`--listen`).
 *
 * mobile-mcp serves `/mcp` statelessly — every POST is a self-contained
 * JSON-RPC message, no session id to carry — so this is one fetch per call.
 * Bearer auth is the server's `MOBILEMCP_AUTH`; without it the server answers
 * 401, which surfaces here as a rejected request.
 */
export class HttpMobileClient extends BaseMobileClient {
  private nextId = 1;

  protected constructor(
    device: string,
    private readonly opts: Required<Pick<HttpMobileClientOptions, "baseUrl" | "timeoutMs">> &
      Pick<HttpMobileClientOptions, "token" | "authHeaders" | "fetchImpl">,
  ) {
    super(device, opts.timeoutMs);
  }

  /** Verify the endpoint answers and the credential is accepted before any device work. */
  static async connect(opts: HttpMobileClientOptions): Promise<HttpMobileClient> {
    const gw = new HttpMobileClient(opts.device, {
      baseUrl: assertSecureBaseUrl(opts.baseUrl),
      token: opts.token,
      authHeaders: opts.authHeaders,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    await gw.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mobile-control", version: "0.1.0" },
    });
    return gw;
  }

  /** Nothing to tear down — no child process, one HTTP request per call. */
  override close(): void {}

  protected async request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // the SDK streams its reply; it also accepts a plain json answer
      accept: "application/json, text/event-stream",
    };
    // DID request signing wins over the bearer — no shared secret to leak.
    if (this.opts.authHeaders) {
      Object.assign(headers, this.opts.authHeaders(payload));
    } else if (this.opts.token) {
      headers.authorization = `Bearer ${this.opts.token}`;
    }

    const response = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `mcp http ${method}: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const message = parseHttpBody(await response.text(), response.headers.get("content-type") ?? "");
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }
}

/** The grant shape a stored pairing exposes (endpoint + device + capability). */
export interface PairingEndpoint {
  endpoint: string;
  deviceId: string;
  token?: string;
}
