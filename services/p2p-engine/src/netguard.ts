/**
 * Outbound-request guard for user-supplied endpoints (device pairings): the
 * engine must never be steered into its own network (SSRF).
 */
import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** Loopback, private, link-local, CGNAT, multicast/reserved and unique-local addresses. */
export function isNonPublicIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.startsWith("::ffff:") ? lower.slice(7) : null;
  const v4 = mapped ?? lower;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Hex-form IPv4-mapped (::ffff:7f00:1) is treated as non-public.
  if (mapped !== null) return true;
  return (
    lower === "::" ||
    lower === "::1" ||
    /^f[cd]/.test(lower) ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff")
  );
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** Literal-IP check only (no DNS) — cheap enough for request validation. */
export function isNonPublicLiteral(endpoint: string): boolean {
  const host = hostOf(endpoint);
  if (host === null) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isNonPublicIp(host);
}

/** Null when every address the endpoint host resolves to is public, else the reason. */
export async function nonPublicEndpointReason(
  endpoint: string,
): Promise<string | null> {
  const host = hostOf(endpoint);
  if (host === null) return "invalid endpoint";
  const addrs = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) return "endpoint does not resolve";
  if (addrs.some(isNonPublicIp))
    return "endpoint resolves to a non-public address";
  return null;
}

/** DNS lookup that refuses non-public answers at connect time (closes DNS rebinding). */
export const publicOnlyLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  dnsLookupCb(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "", 4);
    const list = addrs as unknown as LookupAddress[];
    if (!list.length || list.some((a) => isNonPublicIp(a.address))) {
      const e = Object.assign(
        new Error(`${hostname} resolves to a non-public address`),
        { code: "ENOTPUBLIC" },
      );
      return callback(e, "", 4);
    }
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(
        null,
        list,
      );
    callback(null, list[0].address, list[0].family);
  });
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Minimal `fetch` over node:http(s) whose connections resolve through
 * `publicOnlyLookup`, so the address checked is the address dialed.
 */
export const publicOnlyFetch: typeof fetch = (input, init = {}) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isNonPublicIp(host))
    return Promise.reject(new Error(`${host} is a non-public address`));
  const mod = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: publicOnlyLookup,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined)
              out.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const status = res.statusCode ?? 502;
          const body =
            status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status,
              statusText: res.statusMessage ?? "",
              headers: out,
            }),
          );
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body !== undefined && init.body !== null)
      req.write(init.body as string | Uint8Array);
    req.end();
  });
};
