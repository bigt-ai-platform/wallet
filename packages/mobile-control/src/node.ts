/**
 * Node-only half of the mobile-control client (docs/p2p.md §12): the **stdio**
 * transport for a mobile-mcp running beside the phone, the Ed25519 DID request
 * signer, and the stored-grant connector. Everything here needs Node built-ins
 * (`child_process`, `node:crypto`, `node:fs`), so the React Native / web app
 * imports the root (`mobile-control`) and never this subpath.
 *
 *   Authorization: DID did="did:key:z…", ts="<ms>", sig="<hex>"
 *   base = `mcp-auth:${ts}:${sha256hex(canonicalJson(body))}`
 *
 * The server (`../mobile-mcp`, `MOBILEMCP_AUTH_DIDS`) verifies the Ed25519
 * did:key signature with node:crypto — no shared secret to leak, a fresh
 * signature per request, and a timestamp window against replay.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  BaseMobileClient,
  HttpMobileClient,
  canonicalJson,
  type AuthHeaderFn,
  type HttpMobileClientOptions,
  type PairingEndpoint,
} from "./client.js";

export * from "./index.js";

// ── DID request signing ──────────────────────────────────────────────────

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The exact string both sides sign/verify. */
export function authBase(ts: number | string, body: unknown): string {
  return `mcp-auth:${ts}:${sha256Hex(canonicalJson(body))}`;
}

/** Signs one request — the wallet/engine key stays with its owner. */
export interface RequestSigner {
  did: string;
  sign(base: string): string;
}

/**
 * An Ed25519 signer from a 32-byte seed (hex). Ed25519 because the endpoint
 * verifies with node:crypto alone; the *authorization* layer (the pairing
 * grant, the verdicts) is PQ-signed wherever the engine's keys are PQ.
 */
export function ed25519Signer(seedHex: string, did: string): RequestSigner {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes hex");
  // PKCS8 DER prefix for an Ed25519 private key + the raw seed.
  const key: KeyObject = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    did,
    sign: (base: string) => cryptoSign(null, Buffer.from(base), key).toString("hex"),
  };
}

/** The Authorization header value for one signed request body. */
export function didAuthHeaders(signer: RequestSigner, body: unknown, now: number = Date.now()): Record<string, string> {
  const ts = now;
  return { Authorization: `DID did="${signer.did}", ts="${ts}", sig="${signer.sign(authBase(ts, body))}"` };
}

/** Adapt a {@link RequestSigner} to the client's header callback. */
export function signerAuthHeaders(signer: RequestSigner): AuthHeaderFn {
  return (body: unknown) => didAuthHeaders(signer, body);
}

// ── stdio transport ──────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface StdioMobileClientOptions {
  /** Device identifier as mobile-mcp reports it (mobile_list_available_devices). */
  device: string;
  /** Launch command override (default: the local ../mobile-mcp checkout, else npx). */
  command?: string;
  args?: string[];
}

/**
 * The workspace sibling `../mobile-mcp/lib/index.js`, or null when the
 * checkout is absent/unbuilt (then the npm package is used).
 */
export function localMobileMcpEntry(): string | null {
  const candidate = fileURLToPath(new URL("../../../../mobile-mcp/lib/index.js", import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

/**
 * MCP client over stdio (newline-delimited JSON-RPC 2.0): initialize handshake,
 * then tools/call. Deliberately small — one device, the curated tool surface.
 */
export class StdioMobileClient extends BaseMobileClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, null>,
    device: string,
  ) {
    super(device);
  }

  static async connect(opts: StdioMobileClientOptions): Promise<StdioMobileClient> {
    // Default: the workspace sibling `../mobile-mcp` (AGENTS.md repo layout) —
    // the checkout we develop against; an explicit MOBILE_MCP_ENTRY overrides
    // it, and the published npm package is the fallback when neither exists.
    const entry = process.env.MOBILE_MCP_ENTRY?.trim() || localMobileMcpEntry();
    const command = opts.command ?? (entry ? "node" : "npx");
    const args = opts.args ?? (entry ? [entry] : ["-y", "@mobilenext/mobile-mcp"]);
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    const gw = new StdioMobileClient(child, opts.device);
    createInterface({ input: child.stdout }).on("line", (line) => gw.onLine(line));
    child.on("exit", (code) => gw.failAll(new Error(`mobile-mcp exited (${code})`)));
    await gw.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mobile-control", version: "0.1.0" },
    });
    gw.notify("notifications/initialized", {});
    return gw;
  }

  override close(): void {
    this.child.kill();
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id === undefined || !this.pending.has(msg.id as number)) return;
    const waiter = this.pending.get(msg.id as number)!;
    this.pending.delete(msg.id as number);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  }

  private failAll(e: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(e);
    this.pending.clear();
  }

  private send(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  protected request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}

// ── stored-grant connector ───────────────────────────────────────────────

/**
 * Connect to the user-paired endpoint from a stored grant (docs/p2p.md §12):
 * the engine drives exactly the endpoint and device the user's DID-signed
 * grant named — never anything else.
 */
export async function connectFromGrant(
  grant: PairingEndpoint,
  opts: { timeoutMs?: number; signer?: RequestSigner } = {},
): Promise<HttpMobileClient> {
  const options: HttpMobileClientOptions = {
    device: grant.deviceId,
    baseUrl: grant.endpoint,
    ...(grant.token ? { token: grant.token } : {}),
    ...(opts.signer ? { authHeaders: signerAuthHeaders(opts.signer) } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return HttpMobileClient.connect(options);
}
