import { describe, it, expect } from "vitest";
import {
  amountsMatch,
  createPayout,
  getCaptureStatus,
  paypalAccessToken,
  paypalApiBase,
  paypalConfig,
  paypalEnabled,
  verifyPaypalCapture,
  verifyWebhookSignature,
  type FetchLike,
} from "../src/paypal.js";
import { parseCliArgs } from "../src/cli.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CFG_ENV: Record<string, string | undefined> = { PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec" };

/** A FetchLike that answers the OAuth token call, then routes by URL suffix. */
function routes(map: Record<string, () => Response>): FetchLike {
  return async (url) => {
    if (url.includes("/v1/oauth2/token")) return jsonResponse({ access_token: "t" });
    for (const [needle, make] of Object.entries(map)) if (url.includes(needle)) return make();
    return jsonResponse({ error: "not found" }, 404);
  };
}

describe("paypal configuration", () => {
  it("is disabled until client id and secret are both set", () => {
    expect(paypalEnabled({})).toBe(false);
    expect(paypalEnabled({ PAYPAL_CLIENT_ID: "cid" })).toBe(false);
    expect(paypalEnabled(CFG_ENV)).toBe(true);
    expect(paypalConfig(CFG_ENV)).toMatchObject({ mode: "sandbox", clientId: "cid" });
    expect(paypalConfig({ ...CFG_ENV, PAYPAL_MODE: "live", PAYPAL_WEBHOOK_ID: "wh" })).toMatchObject({
      mode: "live",
      webhookId: "wh",
    });
  });

  it("routes sandbox and live to the matching API hosts", () => {
    expect(paypalApiBase("sandbox")).toContain("sandbox");
    expect(paypalApiBase("live")).toBe("https://api-m.paypal.com");
  });

  it("compares decimal amounts without string-format noise", () => {
    expect(amountsMatch("101", "101.00")).toBe(true);
    expect(amountsMatch("101", "102")).toBe(false);
    expect(amountsMatch(undefined, "101")).toBe(false);
    expect(amountsMatch("abc", "abc")).toBe(false);
  });
});

describe("paypalAccessToken", () => {
  it("posts client credentials as HTTP basic and returns the bearer", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ access_token: "tok-1" });
    };
    const token = await paypalAccessToken(paypalConfig(CFG_ENV)!, fetchImpl);
    expect(token).toBe("tok-1");
    expect(calls[0].url).toContain("/v1/oauth2/token");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(calls[0].init?.body).toContain("client_credentials");
  });

  it("throws on a non-2xx token response", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "invalid_client" }, 401);
    await expect(paypalAccessToken(paypalConfig(CFG_ENV)!, fetchImpl)).rejects.toThrow("paypal token 401");
  });
});

describe("getCaptureStatus", () => {
  it("maps a completed capture", async () => {
    const fetchImpl = routes({
      "/v2/payments/captures/CAP1": () =>
        jsonResponse({ id: "CAP1", status: "COMPLETED", amount: { value: "101.00", currency_code: "USD" } }),
    });
    await expect(getCaptureStatus(paypalConfig(CFG_ENV)!, "CAP1", fetchImpl)).resolves.toEqual({
      id: "CAP1",
      status: "COMPLETED",
      amount: "101.00",
      currency: "USD",
    });
  });

  it("returns null for unknown captures", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes("/v1/oauth2/token") ? jsonResponse({ access_token: "t" }) : jsonResponse({ name: "RESOURCE_NOT_FOUND" }, 404);
    await expect(getCaptureStatus(paypalConfig(CFG_ENV)!, "NOPE", fetchImpl)).resolves.toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.paypal.com/cert",
    "paypal-transmission-id": "tid",
    "paypal-transmission-time": "2026-01-01T00:00:00Z",
  };

  it("is true only when PayPal reports SUCCESS", async () => {
    const ok = routes({ "/v1/notifications/verify-webhook-signature": () => jsonResponse({ verification_status: "SUCCESS" }) });
    const bad = routes({ "/v1/notifications/verify-webhook-signature": () => jsonResponse({ verification_status: "FAILURE" }) });
    expect(await verifyWebhookSignature(paypalConfig({ ...CFG_ENV, PAYPAL_WEBHOOK_ID: "wh" })!, headers, {}, ok)).toBe(true);
    expect(await verifyWebhookSignature(paypalConfig({ ...CFG_ENV, PAYPAL_WEBHOOK_ID: "wh" })!, headers, {}, bad)).toBe(false);
  });

  it("is false without a webhook id or with missing headers", async () => {
    expect(await verifyWebhookSignature(paypalConfig(CFG_ENV)!, headers, {})).toBe(false);
    expect(await verifyWebhookSignature(paypalConfig({ ...CFG_ENV, PAYPAL_WEBHOOK_ID: "wh" })!, {}, {})).toBe(false);
  });
});

describe("createPayout", () => {
  it("returns the batch + first item ids", async () => {
    const fetchImpl = routes({
      "/v2/payments/payouts": () => jsonResponse({ batch_id: "B1", items: [{ payout_item_id: "I1", status: "PENDING" }] }),
    });
    await expect(
      createPayout(paypalConfig(CFG_ENV)!, { receiver: "a@b.com", amount: "101", currency: "USD", senderBatchId: "b1" }, fetchImpl),
    ).resolves.toEqual({ payoutId: "B1", itemId: "I1", status: "PENDING" });
  });

  it("throws when PayPal omits the ids", async () => {
    const fetchImpl = routes({ "/v2/payments/payouts": () => jsonResponse({ batch_id: "B1", items: [{}] }) });
    await expect(
      createPayout(paypalConfig(CFG_ENV)!, { receiver: "a@b.com", amount: "101", currency: "USD", senderBatchId: "b1" }, fetchImpl),
    ).rejects.toThrow("paypal payout missing ids");
  });
});

describe("verifyPaypalCapture", () => {
  it("verifies a COMPLETED capture and matches the expected amount/currency", async () => {
    const fetchImpl = routes({
      "/v2/payments/captures/CAP1": () =>
        jsonResponse({ id: "CAP1", status: "COMPLETED", amount: { value: "101.00", currency_code: "USD" } }),
    });
    const res = await verifyPaypalCapture("CAP1", { env: CFG_ENV, fetchImpl, expected: { amount: "101", currency: "USD" } });
    expect(res).toMatchObject({ verified: true, capture: { id: "CAP1", status: "COMPLETED", amount: "101.00" } });
  });

  it("rejects a non-COMPLETED capture and an amount/currency mismatch", async () => {
    const pending = routes({ "/v2/payments/captures/CAP1": () => jsonResponse({ id: "CAP1", status: "PENDING" }) });
    expect(await verifyPaypalCapture("CAP1", { env: CFG_ENV, fetchImpl: pending })).toMatchObject({ verified: false });

    const wrong = routes({
      "/v2/payments/captures/CAP1": () => jsonResponse({ id: "CAP1", status: "COMPLETED", amount: { value: "999", currency_code: "EUR" } }),
    });
    expect(await verifyPaypalCapture("CAP1", { env: CFG_ENV, fetchImpl: wrong, expected: { amount: "101" } })).toMatchObject({ verified: false });
    expect(await verifyPaypalCapture("CAP1", { env: CFG_ENV, fetchImpl: wrong, expected: { currency: "USD" } })).toMatchObject({ verified: false });
  });

  it("is not configured without credentials and not found when PayPal 404s", async () => {
    expect(await verifyPaypalCapture("CAP1", { env: {} })).toMatchObject({ verified: false });
    const nf: FetchLike = async (url) =>
      url.includes("/v1/oauth2/token") ? jsonResponse({ access_token: "t" }) : jsonResponse({}, 404);
    expect(await verifyPaypalCapture("CAP1", { env: CFG_ENV, fetchImpl: nf })).toMatchObject({ verified: false });
  });
});

describe("cli --paypal-capture parsing", () => {
  it("selects paypal-verify mode and captures the expected terms", () => {
    const { options, errors } = parseCliArgs(["--paypal-capture", "CAP1", "--paypal-amount", "101", "--paypal-currency", "USD"]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ mode: "paypal-verify", paypalCapture: "CAP1", paypalAmount: "101", paypalCurrency: "USD" });
  });
});
