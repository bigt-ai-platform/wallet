/**
 * Production signing guard for the Android app.
 *
 * Every installable artifact — debug, release, AAB — must carry the one
 * certificate recorded in `../signing.sha256`. A second key (a dev release key
 * or the Android debug key) makes Android refuse to upgrade an installed
 * package signed by a different certificate (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`);
 * getting past that requires an uninstall, i.e. wiping the wallet data. So a
 * mismatch fails the build instead of shipping.
 *
 * CLI: `node scripts/signing.mjs keystore` verifies the configured keystore,
 * `node scripts/signing.mjs artifact <apk|aab>` verifies a built artifact.
 * Both exit 1 with the reason on stderr.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_ROOT = path.resolve(HERE, "..");
export const SIGNING_FILE = path.join(WEBAPP_ROOT, "signing.sha256");
export const KEYSTORE_PROPS = path.join(WEBAPP_ROOT, "keystore.properties");

const KEYSTORE_LOADER = `def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('../keystore.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}`;

const rel = (p) => path.relative(WEBAPP_ROOT, p) || p;

/** Lowercase, punctuation-free 64-hex form of a SHA-256 certificate fingerprint. */
export function normalizeFingerprint(value) {
  const hex = String(value ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a SHA-256 fingerprint: ${JSON.stringify(String(value))}`);
  return hex;
}

/** The production certificate fingerprint this checkout builds with. */
export function expectedFingerprint(file = SIGNING_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(`${rel(file)} is missing — record the production certificate SHA-256 there`);
  }
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("#"));
  if (!line) throw new Error(`${rel(file)} is empty`);
  return normalizeFingerprint(line);
}

/** `SHA256: 2A:94:…` lines of `keytool -list -v`. */
export function parseKeytoolFingerprints(output) {
  const out = [];
  for (const m of String(output).matchAll(/SHA256:\s*([0-9A-Fa-f:]+)/g)) out.push(normalizeFingerprint(m[1]));
  return out;
}

/** `Signer #1 certificate SHA-256 digest: …` lines of `apksigner verify`. */
export function parseApksignerFingerprints(output) {
  const out = [];
  for (const m of String(output).matchAll(/SHA-256 digest:\s*([0-9a-fA-F]+)/g)) out.push(normalizeFingerprint(m[1]));
  return out;
}

/**
 * Throws unless every fingerprint is the production one. Returns the expected
 * fingerprint so callers can log it.
 */
export function assertProdFingerprint(actual, what) {
  const expected = expectedFingerprint();
  const list = (Array.isArray(actual) ? actual : [actual]).filter(Boolean);
  if (!list.length) throw new Error(`${what}: no certificate fingerprint found`);
  const foreign = list.map(normalizeFingerprint).filter((f) => f !== expected);
  if (foreign.length) {
    throw new Error(
      `${what} is signed with ${foreign.join(", ")}, not the production key ${expected} — refusing ` +
        `(Android rejects the resulting upgrade with INSTALL_FAILED_UPDATE_INCOMPATIBLE)`,
    );
  }
  return expected;
}

/** Parse `webapp/keystore.properties` (values may contain `=`). */
export function readKeystoreProperties(file = KEYSTORE_PROPS) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `${rel(file)} is missing — every build is signed with the production key and this file points at it`,
    );
  }
  const props = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    props[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword"]) {
    if (!props[key]) throw new Error(`${rel(file)}: missing ${key}`);
  }
  return props;
}

function which(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return null;
}

function scan(roots, file, desc = false) {
  for (const root of roots) {
    if (!root) continue;
    const direct = path.join(root, file);
    if (fs.existsSync(direct)) return direct;
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      if (desc && !/^\d/.test(entry)) continue;
      const p = path.join(root, entry, file);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function findKeytool() {
  const home = process.env.HOME ?? "";
  const direct = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "keytool"),
    which("keytool"),
  ].filter(Boolean);
  for (const p of direct) if (fs.existsSync(p)) return p;
  const found = scan(
    [
      path.join(home, ".sdkman", "candidates", "java"),
      "/usr/lib/jvm",
      path.join(home, ".jdks"),
      path.join(WEBAPP_ROOT, "..", "out", "cache", "jdk21"),
    ],
    "keytool",
  );
  if (!found) throw new Error("keytool not found — install a JDK and set JAVA_HOME");
  return found;
}

export function findApksigner() {
  const home = process.env.HOME ?? "";
  const direct = which("apksigner");
  if (direct) return direct;
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "android-sdk"),
    path.join(home, "Android", "Sdk"),
    "/opt/android-sdk",
    "/usr/lib/android-sdk",
  ].filter(Boolean);
  const found = scan(
    sdks.map((sdk) => path.join(sdk, "build-tools")),
    "apksigner",
    true,
  );
  if (!found) {
    throw new Error("apksigner not found — install the Android build-tools and set ANDROID_HOME");
  }
  return found;
}

function run(cmd, args, env) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    throw new Error(`${path.basename(cmd)} ${args[0] ?? ""} failed: ${detail}`);
  }
}

/** Fingerprint(s) of the certificate configured in keystore.properties. */
export function keystoreFingerprint(props = readKeystoreProperties()) {
  const store = path.isAbsolute(props.storeFile) ? props.storeFile : path.resolve(WEBAPP_ROOT, props.storeFile);
  if (!fs.existsSync(store)) throw new Error(`keystore not found: ${store}`);
  const out = run(
    findKeytool(),
    [
      "-J-Duser.language=en",
      "-list",
      "-v",
      "-keystore",
      store,
      "-storepass:env",
      "WALLET_KT_STOREPASS",
      "-alias",
      props.keyAlias,
    ],
    { WALLET_KT_STOREPASS: props.storePassword },
  );
  const fps = parseKeytoolFingerprints(out);
  if (!fps.length) throw new Error(`${store}: could not read a SHA-256 fingerprint from keytool`);
  return fps;
}

/**
 * Fingerprint(s) of a built APK/AAB. APKs are v2/v3-signed, which only
 * `apksigner` reads; bundles stay v1-signed, which `keytool -jarfile` reads.
 */
export function artifactFingerprint(file) {
  if (!fs.existsSync(file)) throw new Error(`no such artifact: ${file}`);
  const keytool = () => {
    const out = run(findKeytool(), ["-J-Duser.language=en", "-printcert", "-jarfile", file]);
    const fps = parseKeytoolFingerprints(out);
    if (!fps.length) throw new Error(`${path.basename(file)}: could not read a SHA-256 fingerprint from keytool`);
    return fps;
  };
  if (path.extname(file).toLowerCase() === ".aab") return keytool();
  const out = run(findApksigner(), ["verify", "--print-certs", file]);
  const fps = parseApksignerFingerprints(out);
  if (fps.length) return fps;
  return keytool();
}

/** Closing `}` index for the block opened at `openIdx`, or -1 when unbalanced. */
export function findBlockEnd(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function signingConfigsBlock(indent) {
  const p = indent + "    ";
  return (
    `\n${indent}signingConfigs {\n` +
    `${indent}    release {\n` +
    `${p}    storeFile file(keystoreProperties['storeFile'])\n` +
    `${p}    storePassword keystoreProperties['storePassword']\n` +
    `${p}    keyAlias keystoreProperties['keyAlias']\n` +
    `${p}    keyPassword keystoreProperties['keyPassword']\n` +
    `${indent}    }\n` +
    `${indent}}`
  );
}

/**
 * Give `buildTypes.<name>` the production signingConfig, replacing whatever it
 * had. Returns the text unchanged when the block is absent.
 */
function ensureSigningRef(text, name) {
  const m = text.match(new RegExp(`(\\n)([ \\t]*)${name}\\s*\\{`));
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const end = findBlockEnd(text, open);
  if (end < 0) throw new Error(`build.gradle: unbalanced buildTypes.${name} block`);
  const body = text.slice(open + 1, end);
  const line = `\n${m[2]}    signingConfig signingConfigs.release`;
  const existing = body.match(/signingConfig\s+signingConfigs\.\w+/);
  if (existing) return text.slice(0, open + 1) + body.replace(existing[0], "signingConfig signingConfigs.release") + text.slice(end);
  return text.slice(0, open + 1) + line + body + text.slice(end);
}

/**
 * Wire the production keystore into the generated `app/build.gradle` for both
 * build types. Idempotent: an already-patched file comes back unchanged.
 */
export function applySigningGradle(source) {
  let out = String(source);
  const apply = out.match(/[ \t]*apply plugin:\s*['"]com\.android\.application['"][^\n]*\n/);
  if (!apply) throw new Error("build.gradle: com.android.application plugin line not found");
  if (!out.includes("def keystoreProperties")) {
    out = out.replace(apply[0], `${apply[0]}\n${KEYSTORE_LOADER}\n`);
  }

  const btRe = /(\n)([ \t]*)buildTypes\s*\{/;
  const firstBt = out.match(btRe);
  if (!firstBt) throw new Error("build.gradle: android.buildTypes block not found");
  const indent = firstBt[2];

  // A pristine Capacitor/AGP template ships its own debug signingConfig; the
  // block is rewritten rather than patched so no second key can survive.
  const scRe = /(\n)([ \t]*)signingConfigs\s*\{/;
  const sc = out.match(scRe);
  const scBody = signingConfigsBlock(indent);
  if (sc) {
    const open = sc.index + sc[0].length - 1;
    const end = findBlockEnd(out, open);
    if (end < 0) throw new Error("build.gradle: unbalanced android.signingConfigs block");
    out = out.slice(0, sc.index) + scBody + out.slice(end + 1);
  } else {
    out = out.slice(0, firstBt.index) + scBody + out.slice(firstBt.index);
  }

  const bt = out.match(btRe);
  const btOpen = bt.index + bt[0].length - 1;
  const btEnd = findBlockEnd(out, btOpen);
  if (btEnd < 0) throw new Error("build.gradle: unbalanced android.buildTypes block");
  let inner = out.slice(btOpen + 1, btEnd);

  const release = ensureSigningRef(inner, "release");
  if (release === null) throw new Error("build.gradle: android.buildTypes.release block not found");
  inner = release;

  const debug = ensureSigningRef(inner, "debug");
  inner =
    debug ??
    `\n${indent}    debug {\n${indent}        signingConfig signingConfigs.release\n${indent}    }${inner}`;

  return out.slice(0, btOpen + 1) + inner + out.slice(btEnd);
}

function main(argv) {
  const [cmd, target] = argv;
  try {
    if (cmd === "keystore") {
      const props = readKeystoreProperties();
      assertProdFingerprint(keystoreFingerprint(props), props.storeFile);
      console.log(`signing: keystore ok (${expectedFingerprint()})`);
    } else if (cmd === "artifact") {
      if (!target) throw new Error("usage: signing.mjs artifact <apk|aab>");
      assertProdFingerprint(artifactFingerprint(target), path.basename(target));
      console.log(`signing: ${path.basename(target)} ok (${expectedFingerprint()})`);
    } else {
      throw new Error("usage: signing.mjs keystore|artifact <file>");
    }
    return 0;
  } catch (e) {
    console.error(`signing: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
