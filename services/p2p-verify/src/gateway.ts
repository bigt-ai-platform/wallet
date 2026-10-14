/**
 * Device gateway for the verification worker (docs/p2p.md §12).
 *
 * The transports themselves live in the shared **`mobile-control`** package —
 * the general device-control client (Streamable HTTP + stdio) used by the
 * wallet's device screen and the p2p engine alike. This module keeps the
 * worker's narrow `DeviceGateway` seam and adapts it to that client, so the
 * rail-extraction code (`extract.ts` / `worker.ts`) is unchanged.
 *
 *  - **stdio** (`McpGateway`) — spawn mobile-mcp as a child process. Only
 *    viable where the phone is attached to *this* host (adb over USB).
 *  - **Streamable HTTP** (`McpHttpGateway`) — call a mobile-mcp already
 *    running with `--listen` on the machine that has the phone, protected by
 *    the `MOBILEMCP_AUTH` bearer (or a DID-signed request).
 *
 * Consent is identical in both: the gateway only ever touches the device the
 * *user paired and authorized* — their own phone or a simulator — and the
 * engine is never in the loop (no engine-operated devices, §12/§14).
 */
import {
  AndroidMcpClient,
  HttpMobileClient,
  parseAppsText,
  parseDevicesText,
  type DeviceApp,
  type DeviceGateway as SharedDeviceGateway,
  type DeviceNotification,
  type MobileDevice,
  type UiElement,
} from "mobile-control";
import {
  StdioMobileClient,
  localMobileMcpEntry,
  signerAuthHeaders,
  type PairingEndpoint,
  type RequestSigner,
  type StdioMobileClientOptions,
} from "mobile-control/node";

export { parseAppsText, parseDevicesText, localMobileMcpEntry };
export type { PairingEndpoint };

/** A system notification, as the on-phone endpoint reports it. */
export type { DeviceNotification };

/** A connected device, as mobile-mcp reports it. */
export type McpDevice = MobileDevice;
export type { DeviceApp, UiElement };

/** The device actions the worker needs — implement against a real or fake device. */
export type DeviceGateway = SharedDeviceGateway;

export interface McpGatewayOptions extends StdioMobileClientOptions {}

export interface McpHttpGatewayOptions {
  /** Device identifier as mobile-mcp reports it (mobile_list_available_devices). */
  device: string;
  /** Base URL of a mobile-mcp started with `--listen`, e.g. http://192.168.178.71:8787 */
  baseUrl: string;
  /** The server's `MOBILEMCP_AUTH` bearer token. Omit only if the server runs unauthenticated. */
  token?: string;
  /** DID request signer (`MOBILEMCP_AUTH_DIDS` mode) — preferred over a bare bearer. */
  signer?: RequestSigner;
  /** Per-request timeout in ms (default 60s — screenshot on a real device is the slow call). */
  timeoutMs?: number;
}

/** stdio transport, adapted to the worker's DeviceGateway. */
export class McpGateway implements DeviceGateway {
  private constructor(private readonly client: StdioMobileClient) {}

  static async connect(opts: McpGatewayOptions): Promise<McpGateway> {
    return new McpGateway(await StdioMobileClient.connect(opts));
  }

  listApps(): Promise<DeviceApp[]> {
    return this.client.listApps();
  }
  launchApp(appId: string): Promise<void> {
    return this.client.launchApp(appId);
  }
  listElements(): Promise<UiElement[]> {
    return this.client.listElements();
  }
  typeKeys(text: string, submit?: boolean): Promise<void> {
    return this.client.typeKeys(text, submit);
  }
  swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
    return this.client.swipe(direction);
  }
  screenshot(): Promise<Uint8Array> {
    return this.client.screenshot();
  }
  listDevices(): Promise<MobileDevice[]> {
    return this.client.listDevices();
  }
  listTools(): Promise<string[]> {
    return this.client.listTools();
  }
  close(): void {
    this.client.close();
  }
}

/** Streamable-HTTP transport, adapted to the worker's DeviceGateway. */
export class McpHttpGateway implements DeviceGateway {
  private constructor(private readonly client: HttpMobileClient) {}

  /** Wrap an already-connected shared HTTP client (stored-grant path). */
  static fromClient(client: HttpMobileClient): McpHttpGateway {
    return new McpHttpGateway(client);
  }

  static async connect(opts: McpHttpGatewayOptions): Promise<McpHttpGateway> {
    const client = await HttpMobileClient.connect({
      device: opts.device,
      baseUrl: opts.baseUrl,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.signer ? { authHeaders: signerAuthHeaders(opts.signer) } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return new McpHttpGateway(client);
  }

  listApps(): Promise<DeviceApp[]> {
    return this.client.listApps();
  }
  launchApp(appId: string): Promise<void> {
    return this.client.launchApp(appId);
  }
  listElements(): Promise<UiElement[]> {
    return this.client.listElements();
  }
  typeKeys(text: string, submit?: boolean): Promise<void> {
    return this.client.typeKeys(text, submit);
  }
  swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
    return this.client.swipe(direction);
  }
  screenshot(): Promise<Uint8Array> {
    return this.client.screenshot();
  }
  listDevices(): Promise<MobileDevice[]> {
    return this.client.listDevices();
  }
  listTools(): Promise<string[]> {
    return this.client.listTools();
  }
  close(): void {
    this.client.close();
  }
}

/**
 * Connect to the user-paired endpoint from a stored grant (docs/p2p.md §12):
 * the engine drives exactly the endpoint and device the user's DID-signed
 * grant named — never anything else. The deployed on-phone agent
 * (android-remote-control-mcp) speaks its own `android_*` tools, so this uses
 * [AndroidMcpClient]; the mobile-mcp host+adb transports remain available via
 * [McpHttpGateway]/[McpGateway] for the CLI.
 */
export async function connectFromGrant(
  grant: PairingEndpoint,
  opts: { timeoutMs?: number; signer?: RequestSigner } = {},
): Promise<AndroidMcpClient> {
  return AndroidMcpClient.connect({
    device: grant.deviceId,
    baseUrl: grant.endpoint,
    ...(grant.token ? { token: grant.token } : {}),
    ...(opts.signer ? { authHeaders: signerAuthHeaders(opts.signer) } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
