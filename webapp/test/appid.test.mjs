import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_APP_ID,
  assertAppId,
  assertArtifactAppId,
  artifactAppId,
  configuredAppId,
  expectedAppId,
  parseAaptPackage,
} from "../scripts/appid.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const APK = path.join(root, "android/app/build/outputs/apk/release/app-release.apk");

describe("parseAaptPackage", () => {
  it("reads the package from real aapt2 output", () => {
    const out = `package: name='ai.bigt.wallet' versionCode='1000036' versionName='1.0.36' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36'
sdkVersion:'24'
targetSdkVersion:'36'
application-label:'Wallet'
`;
    expect(parseAaptPackage(out)).toBe("ai.bigt.wallet");
  });

  it("returns null when there is no package line", () => {
    expect(parseAaptPackage("sdkVersion:'24'\n")).toBeNull();
  });
});

describe("configured app id", () => {
  it("is the wallet package, not the old com.example.bapp.webapp", () => {
    expect(configuredAppId()).toBe(EXPECTED_APP_ID);
    expect(configuredAppId()).toBe("ai.bigt.wallet");
    expect(expectedAppId()).toBe("ai.bigt.wallet");
  });
});

describe("assertAppId", () => {
  it("passes for the configured package", () => {
    expect(assertAppId("ai.bigt.wallet", "ai.bigt.wallet", "app-release.apk")).toBe("ai.bigt.wallet");
  });

  it("rejects the stale pre-rename package and names the cause", () => {
    expect(() => assertAppId("com.example.bapp.webapp", "ai.bigt.wallet", "app-release.apk")).toThrow(
      /app-release\.apk declares package 'com\.example\.bapp\.webapp'/,
    );
    expect(() => assertAppId("com.example.bapp.webapp", "ai.bigt.wallet", "app-release.apk")).toThrow(
      /stale app id/,
    );
  });
});

describe("build wiring", () => {
  const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

  it("webapp.sh gates the install on the package check", () => {
    const src = read("webapp.sh");
    expect(src).toContain('appid.mjs" artifact');
    expect(src).toContain('PKG="ai.bigt.wallet"');
    // the check sits next to the signing gate, before the install call
    const signing = src.indexOf('signing.mjs" artifact');
    const appid = src.indexOf('appid.mjs" artifact');
    const install = src.indexOf("then install_and_run");
    expect(signing).toBeGreaterThan(-1);
    expect(appid).toBeGreaterThan(signing);
    expect(install).toBeGreaterThan(appid);
  });

  it("deploy.apk.sh gates both the build and the re-downloaded object", () => {
    const src = read("deploy.apk.sh");
    expect((src.match(/appid\.mjs" artifact/g) ?? []).length).toBe(2);
  });

  it("every tracked app-id source agrees on ai.bigt.wallet", () => {
    expect(configuredAppId()).toBe("ai.bigt.wallet");
    const appConfig = read("expo-app/app.config.js");
    expect(appConfig).toMatch(/production:\s*"ai\.bigt\.wallet"/);
  });
});

describe.skipIf(!fs.existsSync(APK))("built artifact", () => {
  it("declares the configured package", () => {
    expect(artifactAppId(APK)).toBe(expectedAppId());
    expect(assertArtifactAppId(APK)).toBe("ai.bigt.wallet");
  });
});
