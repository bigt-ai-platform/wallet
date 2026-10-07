/**
 * PayPal REST client (docs/p2p.md): Invoices v2 in, Payouts v1 out, and
 * `SHA256withRSA` webhook verification.
 *
 * Webhook verification is NOT HMAC: PayPal signs the pipe-delimited string
 * `${transmissionId}|${transmissionTime}|${webhookId}|${crc32Decimal(rawBody)}`
 * with RSA-SHA256. The body must be the raw bytes — never re-serialized — and
 * `webhookId` comes from the subscription record, never the request.
 *
 * Sandbox and live are separate apps (separate credentials + webhook ids).
 */
import { createVerify } from "node:crypto";

export interface PaypalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId: string;
}

/** null when the client id/secret (and webhook id) are not configured. */
export function paypalConfig(env: NodeJS.ProcessEnv = process.env): PaypalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const baseUrl = (env.PAYPAL_API_BASE?.trim() || "https://api-m.paypal.com").replace(/\/+$/, "");
  return { baseUrl, clientId, clientSecret, webhookId: env.PAYPAL_WEBHOOK_ID?.trim() ?? "" };
}

// ── webhook signature (pure parts) ──────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE), as a signed 32-bit integer the way PayPal signs it. */
export function crc32(input: string | Uint8Array): number {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) | 0;
}

export interface WebhookHeaders {
  "paypal-transmission-id"?: string;
  "paypal-transmission-time"?: string;
  "paypal-cert-url"?: string;
  "paypal-transmission-sig"?: string;
  [k: string]: string | undefined;
}

/** The exact signed message (never re-serialize the body before the CRC). */
export function webhookMessage(headers: WebhookHeaders, webhookId: string, rawBody: string): string {
  return `${headers["paypal-transmission-id"] ?? ""}|${headers["paypal-transmission-time"] ?? ""}|${webhookId}|${crc32(rawBody)}`;
}

/** Verify the RSA-SHA256 webhook signature against the certificate URL. */
export async function verifyWebhookSignature(
  headers: WebhookHeaders,
  rawBody: string,
  webhookId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const certUrl = headers["paypal-cert-url"];
  const sig = headers["paypal-transmission-sig"];
  if (!webhookId || !certUrl || !sig || !headers["paypal-transmission-id"]) return false;
  let cert: string;
  try {
    const res = await fetchImpl(certUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    cert = await res.text();
  } catch {
    return false;
  }
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(webhookMessage(headers, webhookId, rawBody), "utf8");
    verifier.end();
    return verifier.verify(cert, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/** True when two decimal money strings are equal (2dp money; no float drift). */
export function amountsMatch(a: string | number, b: string | number): boolean {
  return toMinor(a) === toMinor(b);
}

function toMinor(v: string | number): number {
  const s = typeof v === "number" ? v.toFixed(2) : v.trim();
  const m = /^(-?\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

// ── OAuth + APIs ────────────────────────────────────────────────────────

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

/** Cached OAuth2 client-credentials token. */
export async function paypalAccessToken(
  cfg: PaypalConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const cached = tokenCache.get(cfg.clientId);
  if (cached && cached.expiresAt > now() + 30_000) return cached.token;
  const res = await fetchImpl(`${cfg.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`paypal oauth ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cfg.clientId, { token: data.access_token, expiresAt: now() + data.expires_in * 1000 });
  return data.access_token;
}

async function paypalJson(
  cfg: PaypalConfig,
  token: string,
  method: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<any> {
  const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`paypal ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

export interface InvoiceRequest {
  invoiceNumber: string;
  buyerEmail: string;
  amount: string;
  currency: string;
}

/** Create an exact-amount invoice with the swap id as `invoice_number`. */
export async function createInvoice(
  cfg: PaypalConfig,
  token: string,
  req: InvoiceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; status?: string; links?: Array<{ rel?: string; href?: string }> }> {
  return paypalJson(
    cfg,
    token,
    "POST",
    "/v2/invoicing/invoices",
    {
      invoice_number: req.invoiceNumber,
      primary_recipients: [{ billing_info: { email_address: req.buyerEmail } }],
      items: [
        {
          name: `P2P swap ${req.invoiceNumber}`,
          quantity: "1",
          unit_amount: { currency_code: req.currency, value: req.amount },
        },
      ],
      detail: { payment_term: { term_type: "NO_DUE_DATE" } },
    },
    {},
    fetchImpl,
  );
}

export async function sendInvoice(cfg: PaypalConfig, token: string, invoiceId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await paypalJson(cfg, token, "POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, undefined, {}, fetchImpl);
}

export async function getInvoice(cfg: PaypalConfig, token: string, invoiceId: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  return paypalJson(cfg, token, "GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`, undefined, {}, fetchImpl);
}

export interface PayoutRequest {
  senderBatchId: string;
  receiver: string;
  amount: string;
  currency: string;
  itemId: string;
  emailSubject?: string;
}

/** Pay the seller. `PayPal-Request-Id` de-dupes the request server-side. */
export async function createPayout(
  cfg: PaypalConfig,
  token: string,
  req: PayoutRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ payout_batch_id: string; items?: Array<{ payout_item_id?: string; status?: string }> }> {
  return paypalJson(
    cfg,
    token,
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: { sender_batch_id: req.senderBatchId, email_subject: req.emailSubject ?? "P2P settlement" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: req.receiver,
          sender_item_id: req.itemId,
          amount: { value: req.amount, currency: req.currency },
        },
      ],
    },
    { "PayPal-Request-Id": req.senderBatchId },
    fetchImpl,
  );
}

export async function getPayoutItem(cfg: PaypalConfig, token: string, payoutItemId: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  return paypalJson(cfg, token, "GET", `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`, undefined, {}, fetchImpl);
}

/** Batch status poll (docs/p2p.md fallback when the payout webhook is late). */
export async function getPayoutBatch(cfg: PaypalConfig, token: string, payoutBatchId: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  return paypalJson(cfg, token, "GET", `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, undefined, {}, fetchImpl);
}
