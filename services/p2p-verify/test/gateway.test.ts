import { describe, it, expect } from "vitest";
import {
  McpGateway,
  localMobileMcpEntry,
  parseAppsText,
  parseDevicesText,
} from "../src/gateway.js";

const REQUIRED_TOOLS = [
  "mobile_list_available_devices",
  "mobile_list_apps",
  "mobile_launch_app",
  "mobile_list_elements_on_screen",
  "mobile_swipe_on_screen",
  "mobile_type_keys",
  "mobile_take_screenshot",
];

describe("mobile-mcp wiring (../mobile-mcp)", () => {
  it("resolves the workspace sibling checkout", () => {
    const entry = localMobileMcpEntry();
    // In this workspace the sibling repo is present and built; elsewhere the
    // gateway falls back to the npm package, so only assert when it resolves.
    if (entry) expect(entry).toMatch(/mobile-mcp\/lib\/index\.js$/);
  });

  it("parses the human app list and the json device list", () => {
    expect(parseAppsText("Found these apps on device: WeChat (com.tencent.mm), Alipay (com.eg.android.AlipayGphone)")).toEqual([
      { name: "WeChat", id: "com.tencent.mm" },
      { name: "Alipay", id: "com.eg.android.AlipayGphone" },
    ]);
    expect(parseAppsText('[{"id":"com.tencent.mm","name":"WeChat"}]')).toEqual([{ id: "com.tencent.mm", name: "WeChat" }]);
    expect(parseDevicesText('{"devices":[{"id":"emulator-5554","platform":"android","type":"emulator"}]}')).toEqual([
      { id: "emulator-5554", platform: "android", type: "emulator" },
    ]);
    expect(parseDevicesText("no devices here")).toEqual([]);
  });

  it.runIf(localMobileMcpEntry() !== null)(
    "handshakes with the real ../mobile-mcp server and sees the six tools",
    async () => {
      const gw = await McpGateway.connect({ device: "smoke" });
      try {
        const tools = await gw.listTools();
        for (const name of REQUIRED_TOOLS) expect(tools, name).toContain(name);
      } finally {
        gw.close();
      }
    },
    30_000,
  );
});
