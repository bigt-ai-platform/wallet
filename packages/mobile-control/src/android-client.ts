/**
 * Client for **android-remote-control-mcp** — the Android app that runs an MCP
 * server *on the phone* (AccessibilityService + screenshots), so device control
 * needs no adb and no host machine (docs/p2p.md §12).
 *
 * That app speaks its own `android_*` tool surface (different names, argument
 * names and output shapes than mobile-mcp), so this class adapts it to the same
 * `DeviceGateway` the wallet, the p2p worker and dai already use. It reuses
 * [HttpMobileClient] for the transport (Streamable HTTP, bearer token) and only
 * translates the tool calls and parses the compact TSV screen state.
 *
 * The app is the phone-side analog of httpSMS: a deployed Android app + an HTTP
 * endpoint the user pairs. Consent is the pairing (endpoint + token) plus the
 * app's own Accessibility / per-tool permissions.
 */
import {
  HttpMobileClient,
  base64ToBytes,
  type DeviceApp,
  type DeviceGateway,
  type DeviceNotification,
  type HttpMobileClientOptions,
  type MobileDevice,
  type UiElement,
} from "./client.js";

export interface AndroidMcpClientOptions extends HttpMobileClientOptions {
  /** Tool-name prefix; the app uses `android_` (or `android_<slug>_`). */
  toolPrefix?: string;
}

export type SwipeDirection = "up" | "down" | "left" | "right";

/** `android_list_apps` answers a JSON array of `{package_id,name,…}`. */
export function parseAndroidApps(text: string): DeviceApp[] {
  try {
    const arr = JSON.parse(text) as Array<{ package_id?: string; id?: string; name?: string }>;
    return arr
      .map((a) => ({ id: a.package_id ?? a.id ?? "", name: a.name ?? "" }))
      .filter((a) => a.id.length > 0);
  } catch {
    const apps: DeviceApp[] = [];
    for (const m of text.matchAll(/"package_id"\s*:\s*"([^"]+)"[^}]*?"name"\s*:\s*"([^"]*)"/g)) {
      apps.push({ id: m[1], name: m[2] });
    }
    return apps;
  }
}

export interface ParsedScreenState {
  elements: UiElement[];
  width?: number;
  height?: number;
  /** Package of the focused window, when the app reports one. */
  foreground?: string;
}

/**
 * `android_notification_list` answers a caution prelude followed by
 * `{"notifications":[{notification_id,package_name,app_name,title,text,big_text,
 * sub_text,timestamp,is_ongoing,is_clearable,…}]}`. This extracts and maps it.
 */
export function parseNotificationsText(text: string): DeviceNotification[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { notifications?: Array<Record<string, unknown>> };
    return (parsed.notifications ?? []).map((n) => ({
      ...(typeof n.notification_id === "string" ? { id: n.notification_id } : {}),
      packageName: String(n.package_name ?? ""),
      ...(typeof n.app_name === "string" ? { appName: n.app_name } : {}),
      ...(typeof n.title === "string" ? { title: n.title } : {}),
      ...(typeof n.text === "string" ? { text: n.text } : {}),
      ...(typeof n.big_text === "string" ? { bigText: n.big_text } : {}),
      ...(typeof n.sub_text === "string" ? { subText: n.sub_text } : {}),
      ...(typeof n.timestamp === "number" ? { timestampMs: n.timestamp } : {}),
      isOngoing: n.is_ongoing === true,
      isClearable: n.is_clearable === true,
    }));
  } catch {
    return [];
  }
}

/**
 * Parse `android_get_screen_state`'s compact TSV:
 *
 *   screen:<w>x<h> density:<dpi> orientation:<o>
 *   --- window:<id> type:<TYPE> pkg:<pkg> … focused:<bool> ---
 *   node_id\tclass\ttext\tdesc\tres_id\tbounds\tflags
 *   node_a1b2\tButton\t7\t-\tcom.pkg:id/digit_7\t50,800,270,1000\ton,clk,ena
 *
 * `-` is an empty field; `bounds` is `x1,y1,x2,y2`; flags include
 * `on`(onscreen) `clk`(clickable) `edt`(editable) `foc`(focusable).
 */
export function parseScreenStateTsv(text: string): ParsedScreenState {
  const elements: UiElement[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let foreground: string | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const screen = line.match(/^screen:(\d+)x(\d+)/);
    if (screen) {
      width = Number(screen[1]);
      height = Number(screen[2]);
      continue;
    }

    if (line.startsWith("--- window:")) {
      const pkg = line.match(/\bpkg:([^\s]+)/)?.[1];
      if (pkg && /focused:true/.test(line)) foreground = pkg;
      continue;
    }

    const cols = line.split("\t");
    if (cols.length !== 7 || cols[0] === "node_id" || !cols[0].startsWith("node_")) continue;
    const [id, cls, textCol, descCol, resCol, boundsCol, flags] = cols;

    const el: UiElement = { ref: id };
    if (cls) el.role = cls;
    if (textCol && textCol !== "-") el.text = textCol;
    if (descCol && descCol !== "-") el.label = descCol;
    if (resCol && resCol !== "-") el.viewId = resCol;

    const b = boundsCol.split(",").map(Number);
    if (b.length === 4 && b.every((n) => Number.isFinite(n))) {
      el.bounds = [b[0], b[1], b[2], b[3]];
      el.coordinates = { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
    }
    el.clickable = flags.includes("clk");
    el.editable = flags.includes("edt");
    el.focusable = flags.includes("foc");

    elements.push(el);
  }

  return {
    elements,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(foreground !== undefined ? { foreground } : {}),
  };
}

/**
 * Device control over android-remote-control-mcp's `android_*` MCP tools,
 * adapted to the shared [DeviceGateway] surface.
 */
export class AndroidMcpClient implements DeviceGateway {
  private screen?: { width: number; height: number };

  private constructor(
    private readonly transport: HttpMobileClient,
    private readonly prefix: string,
    private readonly deviceId: string,
  ) {}

  static async connect(opts: AndroidMcpClientOptions): Promise<AndroidMcpClient> {
    const transport = await HttpMobileClient.connect(opts);
    return new AndroidMcpClient(transport, opts.toolPrefix ?? "android_", opts.device);
  }

  private tool(base: string): string {
    return `${this.prefix}${base}`;
  }

  /** tools/call → the first text block. */
  private async call(base: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    const result = await this.transport.rpc("tools/call", { name: this.tool(base), arguments: args }, timeoutMs);
    const blocks = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    const text = blocks.find((b) => b.type === "text")?.text;
    if (text === undefined) throw new Error(`${this.tool(base)}: no text content in tool result`);
    return text;
  }

  private async screenState(
    includeScreenshot = false,
  ): Promise<{ text: string; image?: { data: string; mimeType: string } }> {
    const result = await this.transport.rpc(
      "tools/call",
      { name: this.tool("get_screen_state"), arguments: { include_screenshot: includeScreenshot } },
      60_000,
    );
    const blocks =
      (result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined)
        ?.content ?? [];
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    const img = blocks.find((b) => b.type === "image" && b.data);
    return {
      text,
      ...(img?.data ? { image: { data: img.data, mimeType: img.mimeType ?? "image/jpeg" } } : {}),
    };
  }

  /** The app targets one device (itself); synthesize the mobile-mcp device shape. */
  async listDevices(): Promise<MobileDevice[]> {
    return [{ id: this.deviceId || "self", platform: "android", type: "real", state: "online" }];
  }

  async listTools(): Promise<string[]> {
    return this.transport.listTools();
  }

  async listApps(): Promise<DeviceApp[]> {
    return parseAndroidApps(await this.call("list_apps", { filter: "user" }, 60_000));
  }

  /** The system notification shade (the payee's "收款到账" push, docs/p2p.md §12). */
  async listNotifications(): Promise<DeviceNotification[]> {
    return parseNotificationsText(await this.call("notification_list", {}, 60_000));
  }

  async launchApp(appId: string): Promise<void> {
    await this.call("open_app", { package_id: appId });
  }

  async terminateApp(appId: string): Promise<void> {
    await this.call("close_app", { package_id: appId });
  }

  async foregroundApp(): Promise<string> {
    const { text } = await this.screenState();
    return parseScreenStateTsv(text).foreground ?? "";
  }

  async listElements(): Promise<UiElement[]> {
    const { text } = await this.screenState();
    const parsed = parseScreenStateTsv(text);
    if (parsed.width && parsed.height) this.screen = { width: parsed.width, height: parsed.height };
    return parsed.elements;
  }

  /** Type into the focused editable node (`type_append_text` needs a node id). */
  async typeKeys(text: string, submit?: boolean): Promise<void> {
    const els = await this.listElements();
    const target = els.find((e) => e.editable && e.focusable) ?? els.find((e) => e.editable);
    if (!target?.ref) throw new Error("no editable field on screen — open/focus an input first");
    await this.call("type_append_text", { node_id: target.ref, text });
    if (submit) await this.call("press_key", { key: "ENTER" });
  }

  async swipe(direction: SwipeDirection): Promise<void> {
    const { width, height } = await this.ensureScreen();
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const d = Math.round(Math.min(width, height) * 0.3);
    let x1 = cx;
    let y1 = cy;
    let x2 = cx;
    let y2 = cy;
    if (direction === "up") {
      y1 = cy + Math.round(d / 2);
      y2 = cy - Math.round(d / 2);
    } else if (direction === "down") {
      y1 = cy - Math.round(d / 2);
      y2 = cy + Math.round(d / 2);
    } else if (direction === "left") {
      x1 = cx + Math.round(d / 2);
      x2 = cx - Math.round(d / 2);
    } else {
      x1 = cx - Math.round(d / 2);
      x2 = cx + Math.round(d / 2);
    }
    await this.call("swipe", { x1, y1, x2, y2, duration: 300 });
  }

  async tap(target: { ref?: string; x?: number; y?: number }): Promise<void> {
    if (target.ref) {
      await this.call("tap_node", { node_id: target.ref });
      return;
    }
    if (target.x === undefined || target.y === undefined) throw new Error("ref or x,y required");
    await this.call("tap", { x: target.x, y: target.y });
  }

  async pressButton(button: string): Promise<void> {
    const b = button.toUpperCase();
    if (b === "HOME") return void (await this.call("press_home"));
    if (b === "BACK") return void (await this.call("press_back"));
    if (b === "RECENTS" || b === "APP_SWITCH") return void (await this.call("press_recents"));
    if (b === "NOTIFICATIONS") return void (await this.call("open_notifications"));
    if (b === "ENTER") return void (await this.call("press_key", { key: "ENTER" }));
    throw new Error(`unsupported button for this device: ${button}`);
  }

  async openUrl(url: string): Promise<void> {
    await this.call("open_uri", { uri: url });
  }

  async screenshot(): Promise<Uint8Array> {
    const { image } = await this.screenState(true);
    if (!image) throw new Error("get_screen_state: no image in tool result");
    return base64ToBytes(image.data);
  }

  async screenshotDataUri(): Promise<string> {
    const { image } = await this.screenState(true);
    if (!image) throw new Error("get_screen_state: no image in tool result");
    return `data:${image.mimeType};base64,${image.data}`;
  }

  close(): void {
    this.transport.close();
  }

  private async ensureScreen(): Promise<{ width: number; height: number }> {
    if (!this.screen) await this.listElements();
    return this.screen ?? { width: 1080, height: 2400 };
  }
}
