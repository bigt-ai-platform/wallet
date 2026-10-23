import { readFileSync } from "node:fs";

/** Secrets that may come from a mounted file (`<VAR>_FILE`) instead of the process environ. */
export const SECRET_VARS = [
  "SETTLEMENT_ENGINE_KEY",
  "SETTLEMENT_ESCROW_KEY",
  "SETTLEMENT_ENGINE_KEYS",
  "SETTLEMENT_ADMIN_TOKEN",
  "SETTLEMENT_BLOB_KEY",
  "SETTLEMENT_BLOB_SECRET_KEY",
] as const;

/**
 * Resolve `<VAR>_FILE` into `<VAR>` in-process. The value then never appears in
 * `/proc/<pid>/environ` or `docker inspect`, only in this process's memory.
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv, read: (path: string) => string = (p) => readFileSync(p, "utf8")): void {
  for (const name of SECRET_VARS) {
    const path = env[`${name}_FILE`]?.trim();
    if (!path) continue;
    if (env[name]?.trim()) throw new Error(`set ${name} or ${name}_FILE, not both`);
    const value = read(path).trim();
    if (!value) throw new Error(`${name}_FILE (${path}) is empty`);
    env[name] = value;
  }
}
