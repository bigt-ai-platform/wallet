/**
 * PayPal facade used by the server. Wraps `paypal.ts` behind an interface so
 * the routes are testable without network access, and so a single place owns
 * token acquisition.
 */
import {
  createInvoice as apiCreateInvoice,
  createPayout as apiCreatePayout,
  getPayoutBatch as apiGetPayoutBatch,
  sendInvoice as apiSendInvoice,
  paypalAccessToken,
  type PaypalConfig,
} from "./paypal.js";

export interface PaypalClient {
  createInvoice(swapId: string, buyerEmail: string, amount: string, currency: string): Promise<{ id: string; url?: string }>;
  sendInvoice(invoiceId: string): Promise<void>;
  createPayout(swapId: string, receiver: string, amount: string, currency: string): Promise<{ id: string; itemId?: string }>;
  /** Batch/item status poll — the doc's fallback when a payout webhook is late. */
  getPayout(payoutRef: string): Promise<{ status?: string; itemId?: string }>;
}

export class HttpPaypalClient implements PaypalClient {
  constructor(
    private readonly cfg: PaypalConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private token(): Promise<string> {
    return paypalAccessToken(this.cfg, this.fetchImpl);
  }

  async createInvoice(swapId: string, buyerEmail: string, amount: string, currency: string): Promise<{ id: string; url?: string }> {
    const res = await apiCreateInvoice(
      this.cfg,
      await this.token(),
      { invoiceNumber: swapId, buyerEmail, amount, currency },
      this.fetchImpl,
    );
    const url = res.links?.find((l) => l.rel === "payer-view")?.href;
    return { id: res.id, ...(url ? { url } : {}) };
  }

  async sendInvoice(invoiceId: string): Promise<void> {
    await apiSendInvoice(this.cfg, await this.token(), invoiceId, this.fetchImpl);
  }

  async createPayout(swapId: string, receiver: string, amount: string, currency: string): Promise<{ id: string; itemId?: string }> {
    const res = await apiCreatePayout(
      this.cfg,
      await this.token(),
      { senderBatchId: swapId, itemId: swapId, receiver, amount, currency },
      this.fetchImpl,
    );
    const itemId = res.items?.[0]?.payout_item_id;
    return { id: res.payout_batch_id, ...(itemId ? { itemId } : {}) };
  }

  async getPayout(payoutRef: string): Promise<{ status?: string; itemId?: string }> {
    const res = await apiGetPayoutBatch(this.cfg, await this.token(), payoutRef, this.fetchImpl);
    const item = Array.isArray(res?.items) ? res.items[0] : undefined;
    const itemId = item?.payout_item_id;
    const status = item?.status ?? res?.batch_header?.status;
    return {
      ...(typeof status === "string" ? { status } : {}),
      ...(typeof itemId === "string" ? { itemId } : {}),
    };
  }
}

/**
 * Deterministic in-process PayPal for demo/e2e runs with no PAYPAL_* config
 * (`SETTLEMENT_PAYPAL_INSECURE=1`): invoice and payout ids derive from the
 * swapId, no network is touched, and a polled payout reports SUCCESS so the
 * payout-sync fallback can close the loop. Never used when real credentials
 * are present.
 */
export class MockPaypalClient implements PaypalClient {
  private ref(swapId: string): string {
    return swapId.replace(/^swap-/, "");
  }

  async createInvoice(swapId: string): Promise<{ id: string; url?: string }> {
    const id = `INV-${this.ref(swapId).slice(0, 8)}`;
    return { id, url: `https://sandbox.paypal.test/i/${id}` };
  }

  async sendInvoice(): Promise<void> {
    /* delivered synchronously in mock mode */
  }

  async createPayout(swapId: string): Promise<{ id: string; itemId?: string }> {
    const ref = this.ref(swapId).slice(0, 8);
    return { id: `PO-${ref}`, itemId: `PI-${ref}` };
  }

  async getPayout(payoutRef: string): Promise<{ status?: string; itemId?: string }> {
    return { status: "SUCCESS", itemId: `PI-${payoutRef.replace(/^PO-/, "").slice(0, 8)}` };
  }
}
