/**
 * Durable blob layer for `SETTLEMENT_STORE=blob` (docs/p2p.md §14): the
 * confidential, non-rebuildable half of the engine store — payment profiles,
 * payment proofs and escrow signings — persisted as JSON objects in one of the
 * sanctioned durable stores instead of Postgres.
 *
 * Two backends, no new dependencies:
 *   - `FsBlobStore`  — a directory (a mounted MinIO/Drive volume works).
 *   - `S3BlobStore`  — an S3/MinIO bucket, signed with SigV4 over `fetch`.
 *
 * Wrap either in `EncryptedBlobStore` (`SETTLEMENT_BLOB_KEY`) so the objects are
 * AES-256-GCM at rest: the store holds 实名 accounts, receipt bytes and
 * pre-signed spend signatures, none of which may be readable by whoever owns
 * the bucket. With no key, objects are written in clear — allowed for local
 * dev, warned about, never a prod shape.
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BlobStore {
  get(collection: string, key: string): Promise<Record<string, unknown> | null>;
  put(collection: string, key: string, value: unknown): Promise<void>;
  del(collection: string, key: string): Promise<void>;
  list(collection: string): Promise<string[]>;
}

function encodeKey(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decodeKey(name: string): string {
  return Buffer.from(name, "base64url").toString("utf8");
}

/** Directory-backed store: `<dir>/<collection>/<sha256(key)>.json`, `{key,value}`. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  private collDir(collection: string): string {
    return join(this.dir, encodeKey(collection));
  }

  private path(collection: string, key: string): string {
    // Hash the key into the filename: opaqueness keys are not filesystem-safe
    // (a did:key is ~3.5 kB — far past the 255-byte name limit).
    return join(this.collDir(collection), `${createHash("sha256").update(key, "utf8").digest("hex")}.json`);
  }

  async get(collection: string, key: string): Promise<Record<string, unknown> | null> {
    try {
      const rec = JSON.parse(await readFile(this.path(collection, key), "utf8")) as { key?: string; value?: unknown };
      return rec.key === key ? (rec.value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async put(collection: string, key: string, value: unknown): Promise<void> {
    const path = this.path(collection, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ key, value }), "utf8");
    await rename(tmp, path);
  }

  async del(collection: string, key: string): Promise<void> {
    await rm(this.path(collection, key), { force: true });
  }

  async list(collection: string): Promise<string[]> {
    try {
      const dir = this.collDir(collection);
      const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
      const keys: string[] = [];
      for (const name of names) {
        try {
          const rec = JSON.parse(await readFile(join(dir, name), "utf8")) as { key?: string };
          if (typeof rec.key === "string") keys.push(rec.key);
        } catch {
          // a torn write — skip
        }
      }
      return keys;
    } catch {
      return [];
    }
  }
}

export interface S3BlobConfig {
  /** e.g. `http://127.0.0.1:9000` (MinIO) or `https://s3.eu-central-1.amazonaws.com`. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Object key prefix (no leading slash). */
  prefix?: string;
  fetchImpl?: typeof fetch;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const hex = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("hex");
const hmac = (key: Uint8Array | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

function amzDate(d: Date): { full: string; short: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { full: iso, short: iso.slice(0, 8) };
}

/** SigV4-signed S3 (path-style) — PUT/GET/DELETE object + ListObjectsV2. */
export class S3BlobStore implements BlobStore {
  private readonly base: string;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  /** Injectable clock so the signature is deterministic in tests. */
  now: () => Date;

  constructor(private readonly cfg: S3BlobConfig) {
    this.base = cfg.endpoint.replace(/\/+$/, "");
    this.prefix = (cfg.prefix ?? "").replace(/^\/+/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = () => new Date();
  }

  private objectKey(collection: string, key: string): string {
    return `${this.prefix}${encodeKey(collection)}/${encodeKey(key)}.json`;
  }

  /** Signed request; `body` empty means a bodyless op (GET/DELETE). */
  private async send(method: string, key: string, body: Uint8Array, query = ""): Promise<Response> {
    const url = new URL(`${this.base}/${this.cfg.bucket}/${key}${query}`);
    const { full, short } = amzDate(this.now());
    const payloadHash = method === "GET" || method === "DELETE" ? EMPTY_SHA256 : hex(createHash("sha256").update(body).digest());
    const canonicalUri = url.pathname
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${full}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [method, canonicalUri, query.replace(/^\?/, ""), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${short}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", full, scope, hex(createHash("sha256").update(canonicalRequest).digest())].join("\n");
    let k: Uint8Array = Buffer.from(`AWS4${this.cfg.secretKey}`, "utf8");
    for (const part of [short, this.cfg.region, "s3", "aws4_request"]) k = hmac(k, part);
    const signature = hex(hmac(k, stringToSign));
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-date": full,
      "x-amz-content-sha256": payloadHash,
      authorization,
    };
    if (body.length) headers["content-length"] = String(body.length);
    return this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body.length ? Buffer.from(body) : undefined,
    });
  }

  async get(collection: string, key: string): Promise<Record<string, unknown> | null> {
    const res = await this.send("GET", this.objectKey(collection, key), new Uint8Array(0));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob get ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async put(collection: string, key: string, value: unknown): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(value));
    const res = await this.send("PUT", this.objectKey(collection, key), body);
    if (!res.ok) throw new Error(`blob put ${res.status}`);
  }

  async del(collection: string, key: string): Promise<void> {
    const res = await this.send("DELETE", this.objectKey(collection, key), new Uint8Array(0));
    if (!res.ok && res.status !== 404) throw new Error(`blob del ${res.status}`);
  }

  async list(collection: string): Promise<string[]> {
    const prefix = `${this.prefix}${encodeKey(collection)}/`;
    const q = `?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const res = await this.send("GET", "", new Uint8Array(0), q);
    if (!res.ok) throw new Error(`blob list ${res.status}`);
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    return keys
      .filter((k) => k.startsWith(prefix) && k.endsWith(".json"))
      .map((k) => decodeKey(k.slice(prefix.length).replace(/\.json$/, "")));
  }
}

/** AES-256-GCM envelope. Key is a 32-byte hex secret (`SETTLEMENT_BLOB_KEY`). */
export class EncryptedBlobStore implements BlobStore {
  private readonly key: Buffer;
  constructor(private readonly inner: BlobStore, keyHex: string) {
    const raw = Buffer.from(keyHex, "hex");
    // Accept a 32-byte key, else derive one from the secret (stable, so a
    // longer passphrase works too).
    this.key = raw.length === 32 ? raw : createHash("sha256").update(keyHex, "utf8").digest();
  }

  private encrypt(plain: string): Record<string, unknown> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(env: Record<string, unknown>): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(String(env.iv), "base64"));
    decipher.setAuthTag(Buffer.from(String(env.tag), "base64"));
    return Buffer.concat([decipher.update(Buffer.from(String(env.ct), "base64")), decipher.final()]).toString("utf8");
  }

  async get(collection: string, key: string): Promise<Record<string, unknown> | null> {
    const env = await this.inner.get(collection, key);
    if (!env) return null;
    return JSON.parse(this.decrypt(env)) as Record<string, unknown>;
  }

  async put(collection: string, key: string, value: unknown): Promise<void> {
    await this.inner.put(collection, key, this.encrypt(JSON.stringify(value)));
  }

  del(collection: string, key: string): Promise<void> {
    return this.inner.del(collection, key);
  }

  list(collection: string): Promise<string[]> {
    return this.inner.list(collection);
  }
}

/**
 * Build the blob store from env. `SETTLEMENT_BLOB_URL` selects S3/MinIO,
 * `SETTLEMENT_BLOB_DIR` a directory; `SETTLEMENT_BLOB_KEY` wraps it in AES-GCM.
 * `SETTLEMENT_STORE=blob` with neither URL nor DIR is a hard error (fail
 * closed — never silently fall back to an in-memory store that loses secrets).
 */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  const url = env.SETTLEMENT_BLOB_URL?.trim();
  let base: BlobStore;
  if (url) {
    const bucket = env.SETTLEMENT_BLOB_BUCKET?.trim();
    const accessKey = env.SETTLEMENT_BLOB_ACCESS_KEY?.trim();
    const secretKey = env.SETTLEMENT_BLOB_SECRET_KEY?.trim();
    if (!bucket || !accessKey || !secretKey) {
      throw new Error("SETTLEMENT_BLOB_URL needs SETTLEMENT_BLOB_BUCKET/-ACCESS_KEY/-SECRET_KEY");
    }
    base = new S3BlobStore({
      endpoint: url,
      bucket,
      accessKey,
      secretKey,
      region: env.SETTLEMENT_BLOB_REGION?.trim() || "us-east-1",
      prefix: env.SETTLEMENT_BLOB_PREFIX?.trim() ?? "p2p/",
    });
  } else {
    const dir = env.SETTLEMENT_BLOB_DIR?.trim();
    if (!dir) throw new Error("SETTLEMENT_STORE=blob needs SETTLEMENT_BLOB_URL (S3/MinIO) or SETTLEMENT_BLOB_DIR");
    base = new FsBlobStore(dir);
  }
  const key = env.SETTLEMENT_BLOB_KEY?.trim();
  if (!key) {
    console.warn("p2p-engine: SETTLEMENT_BLOB_KEY unset — blob objects are stored in CLEAR (dev only)");
    return base;
  }
  return new EncryptedBlobStore(base, key);
}
