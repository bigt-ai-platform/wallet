/**
 * Post-`cap sync` patches for the generated Android project. Run from the
 * `sync` script; idempotent.
 *
 * 1. Cleartext HTTP for loopback: Android blocks it since API 28, and `cap
 *    sync` doesn't touch AndroidManifest.xml. Add a loopback-scoped
 *    network_security_config and reference it. Production endpoints are https
 *    and stay enforced.
 * 2. OTA updater: the install permission, the status receiver, and the native
 *    plugin sources (android/ is generated+gitignored, so they live as tracked
 *    templates under native/<name> and are copied in on every sync).
 * 3. Production signing (fail-closed): `android/` is generated, so the
 *    signingConfig can't be committed there. `signing.mjs` injects one for
 *    *both* build types from `keystore.properties` and refuses to continue
 *    unless that keystore holds the certificate pinned in `signing.sha256` —
 *    a second key anywhere turns the next upgrade into
 *    INSTALL_FAILED_UPDATE_INCOMPATIBLE. Create the keystore with:
 *      keytool -genkeypair -v -keystore webapp/release.keystore \
 *        -alias wallet -keyalg RSA -keysize 2048 -validity 10000
 *    and put storeFile/storePassword/keyAlias/keyPassword in
 *    webapp/keystore.properties (both gitignored).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySigningGradle, assertProdFingerprint, keystoreFingerprint, readKeystoreProperties } from "./signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "android", "app", "src", "main");
const manifest = path.join(app, "AndroidManifest.xml");
const xmlDir = path.join(app, "res", "xml");
const nsc = path.join(xmlDir, "network_security_config.xml");
const buildGradle = path.join(root, "android", "app", "build.gradle");
const keystoreProps = path.join(root, "keystore.properties");
const pkgDir = path.join("com", "example", "bapp", "webapp");

if (!fs.existsSync(manifest)) {
  console.error("patch-android: no android/ project — run `npx cap add android` first");
  process.exit(1);
}

// ── 0. version bump ─────────────────────────────────────────────────────────
// The OTA updater compares versionCode against the release manifest, so every
// build bakes a real semver. APP_VERSION_NAME/APP_VERSION_CODE come from the
// release pipeline (webapp.sh/deploy.apk.sh); absent → leave gradle defaults.
const verName = process.env.APP_VERSION_NAME;
const verCode = process.env.APP_VERSION_CODE;
if (verName || verCode) {
  let g = fs.readFileSync(buildGradle, "utf8");
  let changed = false;
  if (verName && /versionName\s+"?[^"\s]+"?/.test(g)) {
    g = g.replace(/versionName\s+"?[^"\s]+"?/, `versionName "${verName.replace(/"/g, "")}"`);
    changed = true;
  }
  if (verCode && /versionCode\s+\d+/.test(g)) {
    g = g.replace(/versionCode\s+\d+/, `versionCode ${parseInt(verCode, 10)}`);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(buildGradle, g);
    console.log(`patch-android: version → ${verName ?? "?"} (code ${verCode ?? "?"})`);
  }
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

// ── 1b. app name from capacitor.config.json ─────────────────────────────────
// `cap add` bakes appName into strings.xml; `cap sync` does not rewrite it, so
// apply the configured name here on every sync.
const capConfig = JSON.parse(fs.readFileSync(path.join(root, "capacitor.config.json"), "utf8"));
const stringsXml = path.join(app, "res", "values", "strings.xml");
if (capConfig.appName && fs.existsSync(stringsXml)) {
  let sx = fs.readFileSync(stringsXml, "utf8");
  sx = sx.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${capConfig.appName}$2`);
  sx = sx.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${capConfig.appName}$2`);
  fs.writeFileSync(stringsXml, sx);
  console.log(`patch-android: app name → ${capConfig.appName}`);
}

// ── 1c. OTA updater: install permission + status receiver ──────────────────
let mx = fs.readFileSync(manifest, "utf8");
if (!mx.includes("REQUEST_INSTALL_PACKAGES")) {
  mx = mx.replace(
    /<uses-permission android:name="android.permission.INTERNET" \/>/,
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
  );
}
if (!mx.includes("UpdateReceiver")) {
  mx = mx.replace(
    "</application>",
    `        <receiver android:name="com.example.bapp.webapp.UpdateReceiver" android:exported="false" />\n    </application>`,
  );
}
if (mx !== fs.readFileSync(manifest, "utf8")) {
  fs.writeFileSync(manifest, mx);
  console.log("patch-android: OTA install permission + UpdateReceiver added");
}

// ── 1d. native plugin sources ───────────────────────────────────────────────
// `android/` is generated+gitignored, so native plugins live in tracked
// templates under native/<name> and are copied in on every sync. The updater
// template also carries MainActivity with the plugin-registering override.
const javaDest = path.join(app, "java", pkgDir);
fs.mkdirSync(javaDest, { recursive: true });
for (const name of ["updater"]) {
  const javaSrc = path.join(root, "native", name, pkgDir);
  if (!fs.existsSync(javaSrc)) {
    console.warn(`patch-android: native/${name} template missing — skipped`);
    continue;
  }
  for (const f of fs.readdirSync(javaSrc)) {
    fs.copyFileSync(path.join(javaSrc, f), path.join(javaDest, f));
  }
  console.log(`patch-android: native/${name} sources → ${path.relative(root, javaDest)}`);
}

// ── 2. production signing (fail-closed) ──────────────────────────────────────
// Debug and release install over the same package, so both carry the pinned
// production certificate. webapp.sh re-checks the artifact itself before it
// reaches a device or an upload.
if (!fs.existsSync(buildGradle)) {
  console.error("patch-android: app/build.gradle missing");
  process.exit(1);
}
try {
  const props = readKeystoreProperties(keystoreProps);
  const fingerprint = keystoreFingerprint(props);
  assertProdFingerprint(fingerprint, `keystore ${props.storeFile}`);
  const gradle = fs.readFileSync(buildGradle, "utf8");
  const patched = applySigningGradle(gradle);
  if (patched !== gradle) {
    fs.writeFileSync(buildGradle, patched);
    console.log("patch-android: production signingConfig applied to debug + release");
  } else {
    console.log("patch-android: production signingConfig already applied");
  }
  console.log(`patch-android: signing verified (${fingerprint[0].slice(0, 16)}…)`);
} catch (e) {
  console.error(`patch-android: ${e.message}`);
  process.exit(1);
}
