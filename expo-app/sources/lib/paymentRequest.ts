/**
 * Payment request building for the wallet's "Receive / request payment" flow.
 *
 * Two interchangeable encodings are produced for the same request:
 *  - a JSON payload (the format the reference Java wallet scanner and this
 *    app's scanner understand: `{ address, quantity, tokenid, memo }`)
 *  - a deep/web link `…/home/payment?address=&amount=&tokenid=&memo=&chain=`
 *    that re-opens this wallet's Send Payment screen with the fields
 *    prefilled, so a payment request can be sent over chat/email.
 *
 * Kept free of react-native imports so the encoding helpers are unit-testable.
 */

export interface PaymentRequestFields {
  /** Recipient (this wallet's own) address. */
  address: string;
  /** Optional amount in display units, e.g. "0.5". */
  amount?: string;
  /** Optional token id, e.g. "bc" for BIG. */
  tokenid?: string;
  /** Optional memo / note. */
  memo?: string;
  /** Optional destination chain id ('0' = settlement, or an L1 chain id). */
  chainId?: string;
}

/** JSON payload for a scannable payment QR (Java-wallet compatible). */
export function buildPaymentRequestJson(fields: PaymentRequestFields): string {
  const payload: Record<string, string> = { address: fields.address };
  if (fields.amount) payload.quantity = fields.amount;
  if (fields.tokenid) payload.tokenid = fields.tokenid;
  if (fields.memo) payload.memo = fields.memo;
  if (fields.chainId) payload.chain = fields.chainId;
  return JSON.stringify(payload);
}

/** URL query string for the shareable payment-request link. */
export function buildPaymentRequestQuery(fields: PaymentRequestFields): string {
  const parts: string[] = [];
  const add = (key: string, value?: string) => {
    if (value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  };
  add('address', fields.address);
  add('amount', fields.amount);
  add('tokenid', fields.tokenid);
  add('memo', fields.memo);
  add('chain', fields.chainId);
  return parts.join('&');
}

/**
 * Shareable link that re-opens the Send Payment screen prefilled. `hostBase`
 * is the app origin on web (e.g. `https://wallet.bigt.ai`) or the app scheme
 * on native (`bigtai://`); falls back to the deep-link scheme.
 */
export function buildPaymentRequestLink(fields: PaymentRequestFields, hostBase?: string): string {
  const base = hostBase || 'bigtai://';
  const query = buildPaymentRequestQuery(fields);
  return query ? `${base}/home/payment?${query}` : `${base}/home/payment`;
}
