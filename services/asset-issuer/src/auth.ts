/**
 * Authentication for the issuer HTTP API.
 *
 * Default-deny outside `Test`: `serve` refuses to start with `AUTH_MODE=off`
 * when `NETWORK != Test` (see `assertAuthAllowsNetwork`).
 *
 * Modes:
 *   - `off`    — Test only. Every request is allowed.
 *   - `bearer` — a shared `API_TOKEN` (`Authorization: Bearer …`). Transport
 *                auth; it does **not** prove which account is calling.
 *   - `hmac`   — account-bound: `x-account`, `x-timestamp`, `x-signature` where
 *                the signature is HMAC-SHA256 over method, path, account,
 *                timestamp and the canonical JSON body. Requires a client that
 *                signs (the current wallet sends only a bearer token).
 *
 * A shared bearer token plus a caller-supplied `account` is not
 * account-bound: use `hmac` (or a DID signature) when the client can sign.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type AuthMode = 'off' | 'bearer' | 'hmac';

export interface AuthConfig {
  mode: AuthMode;
  token?: string;
  hmacSecret?: string;
  /** Allowed clock skew for `x-timestamp`, milliseconds (default 5 min). */
  maxSkewMs?: number;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const MODES: AuthMode[] = ['off', 'bearer', 'hmac'];

export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const raw = (env.AUTH_MODE ?? 'off').trim().toLowerCase();
  if (!MODES.includes(raw as AuthMode)) {
    throw new Error(`AUTH_MODE must be one of ${MODES.join(', ')}, got '${raw}'`);
  }
  const mode = raw as AuthMode;
  const token = env.API_TOKEN?.trim();
  const hmacSecret = env.API_HMAC_SECRET?.trim();
  if (mode === 'bearer' && !token) throw new Error('AUTH_MODE=bearer requires API_TOKEN');
  if (mode === 'hmac' && !hmacSecret) throw new Error('AUTH_MODE=hmac requires API_HMAC_SECRET');

  const skew = Number(env.AUTH_MAX_SKEW_MS ?? 300_000);
  if (!Number.isFinite(skew) || skew < 0) throw new Error('AUTH_MAX_SKEW_MS must be >= 0');

  return {
    mode,
    ...(token ? { token } : {}),
    ...(hmacSecret ? { hmacSecret } : {}),
    maxSkewMs: skew,
  };
}

/** Outside Test, `off` is a configuration error, not a convenience. */
export function assertAuthAllowsNetwork(auth: AuthConfig, network: 'Test' | 'Mainnet'): void {
  if (network !== 'Test' && auth.mode === 'off') {
    throw new Error(
      'refusing to serve without authentication outside Test: set AUTH_MODE=bearer (API_TOKEN) or AUTH_MODE=hmac (API_HMAC_SECRET)',
    );
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function checkBearer(auth: AuthConfig, header: string | undefined): void {
  if (!auth.token) throw new AuthError(500, 'bearer auth is not configured');
  const value = (header ?? '').trim();
  if (!value.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'missing bearer token');
  }
  if (!safeEqual(value.slice(7).trim(), auth.token)) {
    throw new AuthError(401, 'invalid bearer token');
  }
}

/** Stable JSON (sorted object keys) so a client and server agree on the payload. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export interface HmacInput {
  method: string;
  path: string;
  account: string;
  timestamp: string;
  body: unknown;
}

export function hmacPayload(input: HmacInput): string {
  const body = input.method.toUpperCase() === 'GET' || input.method.toUpperCase() === 'HEAD'
    ? ''
    : canonicalJson(input.body ?? {});
  return `${input.method.toUpperCase()}\n${input.path}\n${input.account}\n${input.timestamp}\n${body}`;
}

export function signRequest(secret: string, input: HmacInput): string {
  return createHmac('sha256', secret).update(hmacPayload(input)).digest('hex');
}

export function checkHmac(
  auth: AuthConfig,
  input: HmacInput,
  headers: { account?: string; timestamp?: string; signature?: string },
  now: number = Date.now(),
): void {
  if (!auth.hmacSecret) throw new AuthError(500, 'hmac auth is not configured');
  const timestamp = (headers.timestamp ?? '').trim();
  const signature = (headers.signature ?? '').trim();
  const account = (headers.account ?? '').trim();

  if (!timestamp || !signature) {
    throw new AuthError(401, 'x-timestamp and x-signature are required');
  }
  if (input.account && !account) {
    throw new AuthError(401, 'x-account is required for this route');
  }
  if (account !== input.account) {
    throw new AuthError(403, 'x-account does not match the request account');
  }
  const stamp = Number(timestamp);
  if (!Number.isFinite(stamp)) throw new AuthError(401, 'invalid x-timestamp');
  const skew = Math.abs(now - stamp);
  if (skew > (auth.maxSkewMs ?? 300_000)) throw new AuthError(401, 'x-timestamp is outside the allowed skew');

  const expected = signRequest(auth.hmacSecret, { ...input, account });
  if (!safeEqual(signature, expected)) throw new AuthError(401, 'invalid x-signature');
}
