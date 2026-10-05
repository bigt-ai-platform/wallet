import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEYSTORE_PROPS,
  applySigningGradle,
  assertProdFingerprint,
  expectedFingerprint,
  findBlockEnd,
  normalizeFingerprint,
  parseApksignerFingerprints,
  parseKeytoolFingerprints,
  readKeystoreProperties,
} from "../scripts/signing.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROD = "2a9479a3284ec60a77ab31cc281a91ad3de88e3a11bcee103f303220213d8552";
const DEV = "55037948d5e9d596a86aeb35d4f3eadf5834c2b2182a6c8e9acdab8f88213abf";

const PRISTINE = `apply plugin: 'com.android.application'

android {
    namespace = "ai.bigt.wallet"
    defaultConfig {
        applicationId "ai.bigt.wallet"
        versionCode 1
        versionName "1.0"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
`;

function blockOf(source, name) {
  const open = source.indexOf(name);
  const brace = source.indexOf("{", open);
  const end = findBlockEnd(source, brace);
  expect(end, `${name} block not balanced`).toBeGreaterThan(brace);
  return source.slice(brace + 1, end);
}

function tmpProps(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-props-"));
  const file = path.join(dir, "keystore.properties");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

describe("fingerprint handling", () => {
  it("normalizes colons, spacing and case", () => {
    const spaced = (PROD.match(/../g) ?? []).join(":").toUpperCase();
    expect(normalizeFingerprint(spaced)).toBe(PROD);
    expect(normalizeFingerprint(` ${PROD} `)).toBe(PROD);
  });

  it("rejects anything that is not a SHA-256 fingerprint", () => {
    expect(() => normalizeFingerprint("nope")).toThrow(/not a SHA-256 fingerprint/);
    expect(() => normalizeFingerprint("abcd")).toThrow(/not a SHA-256 fingerprint/);
  });

  it("reads the committed production fingerprint", () => {
    expect(expectedFingerprint()).toBe(PROD);
    expect(fs.readFileSync(path.join(root, "signing.sha256"), "utf8").trim()).toBe(PROD);
  });

  it("parses keytool -list -v output", () => {
    const out = `
Owner: CN=wallet.bigt.ai, OU=bigt.ai, O=bigT.ai, L=Frankfurt, ST=Hessen, C=DE
Issuer: CN=wallet.bigt.ai, OU=bigt.ai, O=bigT.ai, L=Frankfurt, ST=Hessen, C=DE
SHA256: 2A:94:79:A3:28:4E:C6:0A:77:AB:31:CC:28:1A:91:AD:3D:E8:8E:3A:11:BC:EE:10:3F:30:32:20:21:3D:85:52
`;
    expect(parseKeytoolFingerprints(out)).toEqual([PROD]);
    expect(parseKeytoolFingerprints("no certificates here")).toEqual([]);
  });

  it("parses apksigner verify --print-certs output for every signer", () => {
    const out = `
Signer #1 certificate DN: CN=wallet.bigt.ai, OU=bigt.ai, O=bigT.ai, L=Frankfurt, ST=Hessen, C=DE
Signer #1 certificate SHA-256 digest: ${PROD}
Signer #2 certificate DN: CN=wallet.bigt.ai, OU=bigt.ai, O=bigT.ai, L=Frankfurt, ST=Hessen, C=DE
Signer #2 certificate SHA-256 digest: ${DEV}
`;
    expect(parseApksignerFingerprints(out)).toEqual([PROD, DEV]);
  });
});

describe("assertProdFingerprint", () => {
  it("passes for the production certificate", () => {
    expect(assertProdFingerprint(PROD, "fixture")).toBe(PROD);
    expect(assertProdFingerprint([PROD], "fixture")).toBe(PROD);
  });

  it("rejects a foreign key and names the Android failure", () => {
    expect(() => assertProdFingerprint(DEV, "1.0.14.apk")).toThrow(/1\.0\.14\.apk is signed with/);
    expect(() => assertProdFingerprint(DEV, "1.0.14.apk")).toThrow(/INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
    expect(() => assertProdFingerprint([PROD, DEV], "fixture")).toThrow(/not the production key/);
  });

  it("rejects an artifact with no readable certificate", () => {
    expect(() => assertProdFingerprint([], "fixture")).toThrow(/no certificate fingerprint/);
  });
});

describe("readKeystoreProperties", () => {
  it("keeps `=` inside a password", () => {
    const file = tmpProps([
      "storeFile=/home/jcui/keys/app/wallet-release.keystore",
      "storePassword=p=a=ss",
      "keyAlias=wallet",
      "keyPassword=k",
    ]);
    expect(readKeystoreProperties(file).storePassword).toBe("p=a=ss");
    expect(readKeystoreProperties(file).keyAlias).toBe("wallet");
  });

  it("fails when the file or a required field is missing", () => {
    expect(() => readKeystoreProperties("/nonexistent/keystore.properties")).toThrow(/missing/);
    expect(() => readKeystoreProperties(tmpProps(["storeFile=/x", "keyAlias=wallet"]))).toThrow(/storePassword/);
  });

  it("points at the production keystore in this checkout", () => {
    expect(KEYSTORE_PROPS.endsWith(path.join("webapp", "keystore.properties"))).toBe(true);
  });
});

describe("applySigningGradle", () => {
  it("replaces the template debug key with the production signingConfig", () => {
    const out = applySigningGradle(PRISTINE);
    expect(out).toContain("def keystoreProperties");
    expect(out).not.toContain("androiddebugkey");

    const signing = blockOf(out, "signingConfigs");
    expect(signing).toContain("release {");
    expect(signing).toContain("storeFile file(keystoreProperties['storeFile'])");
    expect(signing).toContain("keyAlias keystoreProperties['keyAlias']");
    expect((out.match(/signingConfigs \{/g) ?? []).length).toBe(1);

    const buildTypes = blockOf(out, "buildTypes");
    expect(buildTypes).toMatch(/debug\s*\{\s*signingConfig signingConfigs\.release/);
    expect(buildTypes).toMatch(/release\s*\{\s*signingConfig signingConfigs\.release/);
    expect(out).not.toContain("signingConfigs.debug");
  });

  it("creates a debug buildType when the template has none", () => {
    const out = applySigningGradle(PRISTINE.replace(/    signingConfigs \{[\s\S]*?\n    \}\n/, ""));
    expect(blockOf(out, "buildTypes")).toMatch(/debug\s*\{/);
    expect(blockOf(out, "buildTypes")).toMatch(/release\s*\{\s*signingConfig signingConfigs\.release/);
  });

  it("re-points an existing debug signingConfig instead of adding a second one", () => {
    const out = applySigningGradle(
      PRISTINE.replace(
        "    buildTypes {\n        release {",
        "    buildTypes {\n        debug {\n            signingConfig signingConfigs.debug\n        }\n        release {",
      ),
    );
    expect((out.match(/signingConfig signingConfigs\.release/g) ?? []).length).toBe(2);
    expect(out).not.toContain("signingConfigs.debug");
  });

  it("is idempotent", () => {
    const once = applySigningGradle(PRISTINE);
    expect(applySigningGradle(once)).toBe(once);
  });

  it("keeps everything else in the project file", () => {
    const out = applySigningGradle(PRISTINE);
    expect(out).toContain("versionCode 1");
    expect(out).toContain("proguardFiles getDefaultProguardFile('proguard-android.txt')");
    expect(out).toContain('applicationId "ai.bigt.wallet"');
  });

  it("refuses a project it cannot recognize", () => {
    expect(() => applySigningGradle("println 'hi'\n")).toThrow(/com\.android\.application/);
    expect(() => applySigningGradle("apply plugin: 'com.android.application'\n")).toThrow(/buildTypes/);
  });
});

describe("build wiring", () => {
  const repo = path.resolve(root, "..");
  const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

  it("patch-android verifies the keystore before it patches", () => {
    const src = fs.readFileSync(path.join(root, "scripts", "patch-android.mjs"), "utf8");
    expect(src).toContain("assertProdFingerprint");
    expect(src).toContain("applySigningGradle");
    expect(src).not.toContain("stays unsigned");
  });

  it("webapp.sh checks the artifact and no longer wipes data by default", () => {
    const src = read("webapp.sh");
    expect(src).toContain('signing.mjs" artifact');
    expect(src).toContain("resolve_jdk; resolve_android_sdk");
    expect(src).toContain("--force-reinstall");
    expect(src).not.toMatch(/install -r "\$APK" >\/dev\/null/);
  });

  it("deploy.apk.sh gates the upload on the same check", () => {
    const src = read("deploy.apk.sh");
    expect(src).toContain('signing.mjs" artifact');
    // reports a published release under another key, and verifies the object
    // that actually landed in the bucket
    expect(src).toContain("signed by a DIFFERENT certificate");
    expect(src).toContain("uploaded object sha256");
    expect(src).toContain("could not re-download");
  });
});
