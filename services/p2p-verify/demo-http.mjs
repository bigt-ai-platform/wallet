/**
 * End-to-end demo: the wallet's McpHttpGateway driving a real phone through a
 * remote mobile-mcp over Streamable HTTP (docs/p2p.md §12 — the read happens on
 * the owner's machine; only the MCP endpoint is on the network).
 *
 * Prereq — on the machine that has the phone on adb:
 *   cd ~/gittest/mobile-mcp && npm run build
 *   MOBILEMCP_AUTH=$(openssl rand -hex 16) ANDROID_HOME=$HOME/android-sdk \
 *     node lib/index.js --listen 0.0.0.0:8787
 *
 * Run — from services/p2p-verify (after `yarn build`):
 *   MCP_URL=http://<phone-host>:8787 MCP_TOKEN=<token> node demo-http.mjs
 *
 * Optional: RAIL_APP=com.eg.android.AlipayGphone to drive Alipay instead.
 */
import { McpHttpGateway } from "./dist/index.js";

const baseUrl = (process.env.MCP_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.MCP_TOKEN;
const railApp = process.env.RAIL_APP ?? "com.tencent.mm";

/** Resolve the device id the way an operator would: ask the server. */
const listDevices = async () => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mobile_list_available_devices", arguments: {} },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`mobile_list_available_devices: HTTP ${res.status} (bad token?)`);

  const body = await res.text();
  const dataLine = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const message = JSON.parse(dataLine ? dataLine.slice(5).trim() : body);
  const text = message.result.content.find((c) => c.type === "text").text;
  return JSON.parse(text).devices;
};

const main = async () => {
  console.log(`mobile-mcp endpoint: ${baseUrl}/mcp (auth: ${token ? "bearer token" : "none"})`);

  const devices = await listDevices();
  const device = devices.find((d) => d.platform === "android" && d.state === "online");
  if (!device) throw new Error("no online android device");
  console.log(`device: ${device.name} (${device.id}) — ${device.platform} ${device.version}`);

  const gw = await McpHttpGateway.connect({ device: device.id, baseUrl, token });

  console.log(`\nlaunching ${railApp}...`);
  await gw.launchApp(railApp);
  await new Promise((r) => setTimeout(r, 5000));

  const shot = await gw.screenshot();
  const isJpeg = shot[0] === 0xff && shot[1] === 0xd8;
  console.log(`screenshot: ${shot.length} bytes (${isJpeg ? "jpeg" : "png"})`);

  const elements = await gw.listElements();
  console.log(`elements on screen: ${elements.length}`);
  for (const e of elements.filter((x) => x.text || x.label).slice(0, 8)) {
    console.log(`  text="${e.text ?? ""}" label="${e.label ?? ""}"`);
  }

  gw.close();
  console.log("\nOK — wallet gateway drove the phone through mobile-mcp over HTTP");
  process.exit(0);
};

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
