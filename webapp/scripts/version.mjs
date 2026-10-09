/**
 * Android/OTA release-version resolution — the single source of truth for the
 * versionName/versionCode baked into the APK and published in the OTA manifest.
 *
 * The on-device updater compares versionCode against the release manifest, and
 * deploy.apk.sh refuses to publish a code that does not strictly increase. So
 * the resolved version must be **monotonic**.
 *
 * `git describe --tags` cannot provide that: it returns the nearest tag that is
 * an *ancestor* of HEAD. A tag on a rebased or cherry-picked duplicate commit
 * (e.g. `v1.0.36` living on a commit that never became an ancestor of `main`)
 * is invisible to describe, which then falls back to an older tag and the
 * version silently goes *backwards* — the build can no longer be installed over
 * the live release or published at all. Resolving the *highest* semver tag is
 * monotonic regardless of commit topology.
 *
 * CLI (used by webapp.sh / deploy.apk.sh):
 *   node scripts/version.mjs name          # resolved versionName
 *   node scripts/version.mjs code [name]   # versionCode for that name
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_ROOT = path.resolve(HERE, "..");
export const REPO_ROOT = path.resolve(WEBAPP_ROOT, "..");
export const PACKAGE_JSON = path.join(REPO_ROOT, "expo-app", "package.json");

/** major*1e6 + minor*1e3 + patch, so the code is ordered like the semver. */
export function versionCode(name) {
  const base = String(name ?? "").replace(/[-+].*$/, "");
  const num = (part) => {
    const digits = String(part ?? "").replace(/[^0-9]/g, "");
    return digits ? parseInt(digits, 10) : 0;
  };
  const [major, minor, patch] = base.split(".");
  return num(major) * 1_000_000 + num(minor) * 1_000 + num(patch);
}

/** Normalize `git tag` output: one tag per line, leading `v`, valid semver only. */
export function parseTags(output) {
  return String(output ?? "")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/^v/, ""))
    .filter((t) => /^\d+(\.\d+){0,2}/.test(t));
}

/**
 * Pick the version name, in priority order: an explicit override (the release
 * pipeline's APP_VERSION) → the highest tag in the repo → the app package.json.
 */
export function pickVersionName({ explicit, tags = [], packageVersion } = {}) {
  if (explicit) return explicit;
  if (tags.length) return tags[0];
  return packageVersion || "0.0.0";
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** All version tags, highest first (git's version sort — v1.0.10 > v1.0.9). */
export function repoTags() {
  return parseTags(git(["tag", "--list", "v[0-9]*", "--sort=-v:refname"]));
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Resolve from the environment/override, else the repo, else package.json. */
export function resolveVersionName(explicit = process.env.APP_VERSION_NAME || process.env.APP_VERSION) {
  return pickVersionName({ explicit, tags: repoTags(), packageVersion: packageVersion() });
}

function main(argv) {
  const [cmd, arg] = argv;
  try {
    if (cmd === "name") {
      console.log(resolveVersionName());
    } else if (cmd === "code") {
      const name = arg || resolveVersionName();
      console.log(versionCode(name));
    } else {
      throw new Error("usage: version.mjs name | code [name]");
    }
    return 0;
  } catch (e) {
    console.error(`version: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
