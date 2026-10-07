import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { amountsMatch, crc32, verifyWebhookSignature, webhookMessage, type WebhookHeaders } from "../src/paypal.js";

describe("paypal webhook verification", () => {
  it("computes CRC-32 (signed int32)", () => {
    expect(crc32("123456789")).toBe(-873187034); // 0xCBF43926
  });

  it("builds the exact pipe-delimited message", () => {
    const headers: WebhookHeaders = { "paypal-transmission-id": "tid", "paypal-transmission-time": "2026-01-01T00:00:00Z" };
    expect(webhookMessage(headers, "WH-1", "123456789")).toBe(`tid|2026-01-01T00:00:00Z|WH-1|${crc32("123456789")}`);
  });

  it("verifies an RSA-SHA256 signature against the cert URL", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const cert = publicKey.export({ type: "spki", format: "pem" }).toString();
    const raw = JSON.stringify({ event_type: "INVOICING.INVOICE.PAID" });
    const webhookId = "WH-1";
    const headers: WebhookHeaders = {
      "paypal-transmission-id": "tid",
      "paypal-transmission-time": "2026-01-01T00:00:00Z",
      "paypal-cert-url": "https://api.paypal.com/cert.pem",
    };
    const message = webhookMessage(headers, webhookId, raw);
    const sig = rsaSign("RSA-SHA256", Buffer.from(message, "utf8"), privateKey).toString("base64");
    const withSig: WebhookHeaders = { ...headers, "paypal-transmission-sig": sig };

    const fetchCert = (async () => ({ ok: true, text: async () => cert })) as unknown as typeof fetch;
    expect(await verifyWebhookSignature(withSig, raw, webhookId, fetchCert)).toBe(true);
    // wrong body → CRC changes → signature no longer matches
    expect(await verifyWebhookSignature(withSig, raw + " ", webhookId, fetchCert)).toBe(false);
    // missing header
    expect(await verifyWebhookSignature(headers, raw, webhookId, fetchCert)).toBe(false);
  });

  it("compares money without float drift", () => {
    expect(amountsMatch("101.00", "101")).toBe(true);
    expect(amountsMatch("101.10", "101.1")).toBe(true);
    expect(amountsMatch("101.01", "101.00")).toBe(false);
  });
});
