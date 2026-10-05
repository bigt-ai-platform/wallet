/**
 * Android application-id guard for the built wallet artifact.
 *
 * `cap sync` copies the web assets into the generated `webapp/android/`
 * project; it does **not** rename the Android package. So changing `appId` in
 * `capacitor.config.json` alone leaves the generated project (and therefore
 * every APK) carrying the previous package — the exact drift that shipped
 * `com.example.bapp.webapp` after the project was renamed to `ai.bigt.wallet`.
 * Installing or uploading such an artifact silently forks the app: a device
 * keeps the old package, the new one installs alongside it with empty data,
 * and a wallet import appears to "work" in a different app.
 *
 * This guard reads the package the artifact actually declares and refuses to
 * let it reach a device or the release bucket unless it matches the configured
 * app id. CLI: `node scripts/appid.mjs artifact <apk>`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_ROOT = path.resolve(HERE, "..");
export const CAP_CONFIG = path.join(WEBAPP_ROOT, "capacitor.config.json");
export const EXPECTED_APP_ID = "ai.bigt.wallet";

const rel = (p) => path.relative(WEBAPP_ROOT, p) || p;

/** The app id declared in `capacitor.config.json` — the single source of truth. */
export function configuredAppId(file = CAP_CONFIG) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!cfg?.appId || typeof cfg.appId !== "string") {
    throw new Error(`${rel(file)}: missing appId`);
  }
  return cfg.appId;
}

/**
 * The app id every artifact must carry. Uses the checked-in `.config.json`
 * when present, else the constant — the shipped wallet is always
 * `ai.bigt.wallet`, and `EXPO_PUBLIC_APK_ENV` does not change the Android
 * package.
 */
export function expectedAppId(file = CAP_CONFIG) {
  if (fs.existsSync(file)) return configuredAppId(file);
  return EXPECTED_APP_ID;
}

/** `package: name='ai.bigt.wallet' …` line of `aapt2 dump badging`. */
export function parseAaptPackage(output) {
  const m = String(output).match(/^\s*package:\s+name='([^']+)'/m);
  return m ? m[1] : null;
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

/** Locate `aapt2` (preferred) or `aapt` from the Android build-tools. */
export function findAapt() {
  const home = process.env.HOME ?? "";
  const direct = [which("aapt2"), which("aapt")].filter(Boolean);
  for (const p of direct) if (fs.existsSync(p)) return p;
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
    "aapt2",
    true,
  );
  if (!found) {
    throw new Error("aapt2 not found — install the Android build-tools and set ANDROID_HOME");
  }
  return found;
}

/** Package name declared by a built `.apk`. */
export function artifactAppId(file) {
  if (!fs.existsSync(file)) throw new Error(`no such artifact: ${file}`);
  let out;
  try {
    out = execFileSync(findAapt(), ["dump", "badging", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    throw new Error(`aapt dump badging ${path.basename(file)} failed: ${detail}`);
  }
  const pkg = parseAaptPackage(out);
  if (!pkg) throw new Error(`${path.basename(file)}: could not read the package name`);
  return pkg;
}

/**
 * Throws unless `actual` equals `expected`. Pure, so the failure message is
 * unit-testable without a built artifact.
 */
export function assertAppId(actual, expected, what = "artifact") {
  if (actual !== expected) {
    throw new Error(
      `${what} declares package '${actual}', expected '${expected}' — the generated ` +
        `Android project kept a stale app id (cap sync does not rename the package); ` +
        `regenerate webapp/android or fix webapp/android/app/build.gradle namespace/applicationId`,
    );
  }
  return actual;
}

/**
 * Throws unless the artifact declares the configured app id. Returns it so
 * callers can log it.
 */
export function assertArtifactAppId(file, expected = expectedAppId()) {
  return assertAppId(artifactAppId(file), expected, path.basename(file));
}

function main(argv) {
  const [cmd, target] = argv;
  try {
    if (cmd === "artifact") {
      if (!target) throw new Error("usage: appid.mjs artifact <apk>");
      if (path.extname(target).toLowerCase() === ".aab") {
        // The bundle's manifest is protobuf; Play validates it on upload. The
        // wallet only sideloads APKs, which is where the drift bit us.
        console.log(`appid: ${path.basename(target)} skipped (app bundle)`);
      } else {
        const pkg = assertArtifactAppId(target);
        console.log(`appid: ${path.basename(target)} ok (${pkg})`);
      }
    } else if (cmd === "expected") {
      console.log(expectedAppId());
    } else {
      throw new Error("usage: appid.mjs artifact <apk> | expected");
    }
    return 0;
  } catch (e) {
    console.error(`appid: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
