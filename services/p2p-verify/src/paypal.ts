/**
 * PayPal REST client + capture verification (standalone operator tool).
 *
 * PayPal is not a P2P rail: the engine settles CNY rails only (docs/p2p.md §7)
 * and the wallet offers no PayPal option. This module backs the p2p-verify CLI
 * (`--paypal-capture`): it polls PayPal's REST API to confirm a captured
 * payment instead of trusting the payer's claim, checks a webhook signature, or
 * sends a payout. Nothing in the engine or the wallet calls it.
 *
 * Everything is disabled until `PAYPAL_CLIENT_ID` + `PAYPAL_SECRET` are set.
 */
export interface PayPalConfig {
  clientId: string;
  secret: string;
  mode: "sandbox" | "live";
  webhookId?: string;
}

export interface CaptureInfo {
  id: string;
  status: string;
  amount?: string;
  currency?: string;
}

export interface PayoutResult {
  payoutId: string;
  itemId: string;
  status: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function paypalConfig(env: Record<string, string | undefined> = process.env): PayPalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_SECRET?.trim();
  if (!clientId || !secret) return null;
  const mode = env.PAYPAL_MODE === "live" ? "live" : "sandbox";
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  return { clientId, secret, mode, ...(webhookId ? { webhookId } : {}) };
}

export function paypalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return paypalConfig(env) !== null;
}

export function paypalApiBase(mode: PayPalConfig["mode"]): string {
  return mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function timeout(): AbortSignal {
  return AbortSignal.timeout(15_000);
}

async function callPayPal(
  cfg: PayPalConfig,
  path: string,
  init: RequestInit & { token?: string },
  fetchImpl: FetchLike,
): Promise<Response> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetchImpl(`${paypalApiBase(cfg.mode)}${path}`, { ...rest, headers, signal: timeout() });
}

/** OAuth client-credentials token (short-lived; fetched per call). */
export async function paypalAccessToken(
  cfg: PayPalConfig,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<string> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString("base64");
  const res = await fetchImpl(`${paypalApiBase(cfg.mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`paypal token ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("paypal token missing access_token");
  return data.access_token;
}

/** Look up a captured payment. Returns null for unknown ids / transport errors. */
export async function getCaptureStatus(
  cfg: PayPalConfig,
  captureId: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<CaptureInfo | null> {
  try {
    const token = await paypalAccessToken(cfg, fetchImpl);
    const res = await callPayPal(
      cfg,
      `/v2/payments/captures/${encodeURIComponent(captureId)}`,
      { method: "GET", token },
      fetchImpl,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: string;
      status?: string;
      amount?: { value?: string; currency_code?: string };
    };
    if (!data.status) return null;
    return {
      id: data.id ?? captureId,
      status: data.status,
      amount: data.amount?.value,
      currency: data.amount?.currency_code,
    };
  } catch {
    return null;
  }
}

/** PayPal's server-side webhook signature check (`verification_status === "SUCCESS"`). */
export async function verifyWebhookSignature(
  cfg: PayPalConfig,
  headers: Record<string, string | undefined>,
  webhookEvent: unknown,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<boolean> {
  if (!cfg.webhookId) return false;
  const h = (name: string) => headers[name]?.trim() || "";
  const authAlgo = h("paypal-auth-algo");
  const certUrl = h("paypal-cert-url");
  const transmissionId = h("paypal-transmission-id");
  const transmissionTime = h("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionTime) return false;
  try {
    const token = await paypalAccessToken(cfg, fetchImpl);
    const res = await callPayPal(
      cfg,
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        token,
        body: JSON.stringify({
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_time: transmissionTime,
          webhook_id: cfg.webhookId,
          webhook_event: webhookEvent,
        }),
      },
      fetchImpl,
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { verification_status?: string };
    return data.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}

/** Send money from a business account (used by payout flows outside the CNY engine). */
export async function createPayout(
  cfg: PayPalConfig,
  opts: {
    receiver: string;
    amount: string;
    currency: string;
    note?: string;
    senderBatchId: string;
  },
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<PayoutResult> {
  const token = await paypalAccessToken(cfg, fetchImpl);
  const res = await callPayPal(
    cfg,
    "/v2/payments/payouts",
    {
      method: "POST",
      token,
      body: JSON.stringify({
        sender_batch_id: opts.senderBatchId,
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: opts.amount, currency_code: opts.currency },
            note: opts.note?.slice(0, 200),
            receiver: opts.receiver,
            sender_item_id: opts.senderBatchId,
          },
        ],
      }),
    },
    fetchImpl,
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`paypal payout ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as {
    batch_id?: string;
    items?: Array<{ payout_item_id?: string; status?: string }>;
  };
  const item = data.items?.[0];
  if (!data.batch_id || !item?.payout_item_id) throw new Error("paypal payout missing ids");
  return { payoutId: data.batch_id, itemId: item.payout_item_id, status: item.status ?? "PENDING" };
}

/** Decimal-safe equality for payout/capture amounts ("101" vs "101.00"). */
export function amountsMatch(a: unknown, b: unknown): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 1e-9;
}

export interface PaypalCaptureVerifyResult {
  verified: boolean;
  reason?: string;
  capture?: CaptureInfo;
}

/**
 * Verify one PayPal payment by its **capture id**: the capture must be
 * `COMPLETED`, and (when [expected] is given) its amount and currency must
 * match. Reads PayPal's own REST API, so it is not the payer's word.
 */
export async function verifyPaypalCapture(
  captureId: string,
  opts: {
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
    expected?: { amount?: string; currency?: string };
  } = {},
): Promise<PaypalCaptureVerifyResult> {
  const cfg = paypalConfig(opts.env ?? process.env);
  if (!cfg) return { verified: false, reason: "PayPal not configured (set PAYPAL_CLIENT_ID/PAYPAL_SECRET)" };
  const id = captureId?.trim();
  if (!id) return { verified: false, reason: "captureId required" };

  const capture = await getCaptureStatus(cfg, id, opts.fetchImpl);
  if (!capture) return { verified: false, reason: "capture not found or PayPal unreachable" };
  if (capture.status !== "COMPLETED") return { verified: false, reason: `capture is ${capture.status}`, capture };

  if (opts.expected?.amount !== undefined && !amountsMatch(opts.expected.amount, capture.amount)) {
    return { verified: false, reason: "amount does not match", capture };
  }
  if (opts.expected?.currency && capture.currency && opts.expected.currency !== capture.currency) {
    return { verified: false, reason: "currency does not match", capture };
  }
  return { verified: true, capture };
}
