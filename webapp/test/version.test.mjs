import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT,
  pickVersionName,
  parseTags,
  repoTags,
  resolveVersionName,
  versionCode,
} from "../scripts/version.mjs";

const repoFile = (p) => fs.readFileSync(path.join(REPO_ROOT, p), "utf8");

describe("versionCode", () => {
  it("orders like semver (major*1e6 + minor*1e3 + patch)", () => {
    expect(versionCode("1.0.36")).toBe(1000036);
    expect(versionCode("1.0.9")).toBe(1000009);
    expect(versionCode("1.0.10")).toBe(1000010);
    expect(versionCode("v1.2.3")).toBe(1002003);
    expect(versionCode("1.0.37-rc1")).toBe(1000037);
  });

  it("strictly increases across the release train", () => {
    expect(versionCode("1.0.36")).toBeGreaterThan(versionCode("1.0.35"));
    expect(versionCode("1.0.10")).toBeGreaterThan(versionCode("1.0.9"));
    expect(versionCode("1.1.0")).toBeGreaterThan(versionCode("1.0.999"));
  });
});

describe("pickVersionName", () => {
  it("prefers an explicit override", () => {
    expect(pickVersionName({ explicit: "1.0.40", tags: ["1.0.36"], packageVersion: "1.0.0" })).toBe("1.0.40");
  });

  it("uses the highest tag, not the nearest ancestor", () => {
    expect(pickVersionName({ tags: ["1.0.36", "1.0.35"], packageVersion: "1.0.0" })).toBe("1.0.36");
  });

  it("falls back to package.json only when there are no tags", () => {
    expect(pickVersionName({ tags: [], packageVersion: "1.0.0" })).toBe("1.0.0");
    expect(pickVersionName({})).toBe("0.0.0");
  });
});

describe("parseTags", () => {
  it("strips the v prefix and drops non-semver tags", () => {
    expect(parseTags("v1.0.36\n1.0.35\nrelease-foo\n\nv1.0.34\n")).toEqual([
      "1.0.36",
      "1.0.35",
      "1.0.34",
    ]);
  });
});

describe("repo resolution (regression: tag topology must not go backwards)", () => {
  it("resolves to at least the highest tag even when it is off the ancestry line", () => {
    const tags = repoTags();
    expect(tags.length).toBeGreaterThan(0);
    const resolved = resolveVersionName();
    // APP_VERSION override, if the CI set one, is allowed to be higher.
    expect(versionCode(resolved)).toBeGreaterThanOrEqual(versionCode(tags[0]));
    // the specific regression: v1.0.36 was invisible to `git describe`
    expect(versionCode(resolved)).toBeGreaterThanOrEqual(1000036);
  });
});

describe("build wiring", () => {
  it("webapp.sh resolves the version via version.mjs, not git describe", () => {
    const src = repoFile("webapp.sh");
    expect(src).toContain("scripts/version.mjs");
    expect(src).not.toMatch(/\$\(git describe/);
  });

  it("deploy.apk.sh resolves the version via version.mjs, not git describe", () => {
    const src = repoFile("deploy.apk.sh");
    expect(src).toContain("scripts/version.mjs");
    expect(src).not.toMatch(/\$\(git describe/);
  });
});
