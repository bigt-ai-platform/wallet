/**
 * Post-`cap sync` patches for the generated Android project. Run from the
 * `sync` script; idempotent.
 *
 * 1. Cleartext HTTP for loopback: Android blocks it since API 28, and `cap
 *    sync` doesn't touch AndroidManifest.xml. Add a loopback-scoped
 *    network_security_config and reference it. Production endpoints are https
 *    and stay enforced.
 * 2. Release signing: `android/` is generated, so the signingConfig can't be
 *    committed there. When `apps/webapp/keystore.properties` exists, inject a
 *    release signingConfig into app/build.gradle so `assembleRelease`/AAB is
 *    signed. Create the keystore with:
 *      keytool -genkeypair -v -keystore apps/webapp/release.keystore \
 *        -alias aifeeds -keyalg RSA -keysize 2048 -validity 10000
 *    and put storeFile/storePassword/keyAlias/keyPassword in
 *    apps/webapp/keystore.properties (both gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "android", "app", "src", "main");
const manifest = path.join(app, "AndroidManifest.xml");
const xmlDir = path.join(app, "res", "xml");
const nsc = path.join(xmlDir, "network_security_config.xml");
const buildGradle = path.join(root, "android", "app", "build.gradle");
const keystoreProps = path.join(root, "keystore.properties");

if (!fs.existsSync(manifest)) {
  console.error("patch-android: no android/ project — run `npx cap add android` first");
  process.exit(1);
}

// ── 1. loopback cleartext ───────────────────────────────────────────────────
fs.mkdirSync(xmlDir, { recursive: true });
fs.writeFileSync(
  nsc,
  `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`,
);

let xml = fs.readFileSync(manifest, "utf8");
if (!xml.includes("android:networkSecurityConfig")) {
  xml = xml.replace(
    /<application\b/,
    '<application\n        android:networkSecurityConfig="@xml/network_security_config"',
  );
  fs.writeFileSync(manifest, xml);
  console.log("patch-android: manifest + network_security_config updated");
}

// ── 2. release signing ──────────────────────────────────────────────────────
if (!fs.existsSync(keystoreProps)) {
  console.log("patch-android: no keystore.properties — release build stays unsigned");
  process.exit(0);
}
if (!fs.existsSync(buildGradle)) {
  console.error("patch-android: app/build.gradle missing");
  process.exit(1);
}
let gradle = fs.readFileSync(buildGradle, "utf8");
if (gradle.includes("signingConfigs.release")) {
  console.log("patch-android: signing already configured");
  process.exit(0);
}

gradle = gradle.replace(
  "apply plugin: 'com.android.application'",
  `apply plugin: 'com.android.application'

def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('../keystore.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}`,
);
gradle = gradle.replace(
  /(\n\s*)buildTypes\s*\{/,
  `$1signingConfigs {
$1    release {
$1        storeFile file(keystoreProperties['storeFile'])
$1        storePassword keystoreProperties['storePassword']
$1        keyAlias keystoreProperties['keyAlias']
$1        keyPassword keystoreProperties['keyPassword']
$1    }
$1}
$1buildTypes {`,
);
gradle = gradle.replace(
  /(buildTypes\s*\{\s*\n\s*release\s*\{\s*\n)/,
  "$1            signingConfig signingConfigs.release\n",
);
fs.writeFileSync(buildGradle, gradle);
console.log("patch-android: release signingConfig injected");
