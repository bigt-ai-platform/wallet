/**
 * QR content parsing for the wallet.
 *
 * Mirrors the reference Java wallet (`TransactionPaymentFragment`): a scannable
 * payment request is a JSON object `{ address, quantity, tokenid, memo }` whose
 * fields prefill the Send Payment form. The scanner also accepts plain
 * addresses and web links so the same "scan" flow serves both payment
 * requests and url links.
 */

/** A payment request decoded from a QR code. Amount is in display units. */
export interface ParsedPaymentRequest {
  address: string;
  amount?: string;
  tokenid?: string;
  memo?: string;
  /** Optional target chain id: '0' = L0 settlement or a configured L1 chain id. */
  chainId?: string;
}

export type QrParseResult =
  | { kind: 'payment'; request: ParsedPaymentRequest }
  | { kind: 'url'; url: string }
  | { kind: 'unknown'; text: string };

/** http(s) link or bare `www.` domain. */
export function isWebUrl(text: string): boolean {
  const s = text.trim();
  return /^https?:\/\//i.test(s) || /^www\.[a-z0-9-]+\./i.test(s);
}

// bigtangle addresses: EC keys use bitcoin-style base58
// (`VersionedChecksummedBytes`, e.g. 1… or testnet n…); PQ keys use the 35-byte
// PQ address rendered as hex (70 chars, prefixed by the network header byte).
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{20,50}$/;
const HEX_ADDRESS_RE = /^[0-9a-fA-F]{40,128}$/;

export function isAddressLike(text: string): boolean {
  const s = text.trim();
  return BASE58_ADDRESS_RE.test(s) || HEX_ADDRESS_RE.test(s);
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** A decimal quantity in display units (the form accepts "0.001"). */
function asAmount(v: unknown): string | undefined {
  const s = asString(v)?.trim();
  if (!s) return undefined;
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return s;
}

/**
 * Normalize a scanned payment JSON object. Returns null when no address is
 * present (the only mandatory field).
 */
export function paymentRequestFromJson(obj: Record<string, unknown>): ParsedPaymentRequest | null {
  const address = asString(obj.address ?? obj.to ?? obj.recipient)?.trim();
  if (!address) return null;

  const req: ParsedPaymentRequest = { address };
  const amount = asAmount(obj.quantity ?? obj.amount ?? obj.value);
  if (amount !== undefined) req.amount = amount;

  const tokenid = asString(obj.tokenid ?? obj.tokenId ?? obj.token)?.trim();
  if (tokenid) req.tokenid = tokenid;

  const memo = asString(obj.memo ?? obj.note)?.trim();
  if (memo) req.memo = memo;

  const chainId = asString(obj.chain ?? obj.chainId)?.trim();
  if (chainId) req.chainId = chainId;

  return req;
}

/**
 * Classify scanned QR content:
 *  - `{address, quantity|amount, tokenid, memo}` JSON → payment request
 *  - http(s)/www link → url
 *  - a plain bigtangle address → payment request (address only)
 *  - anything else → unknown
 */
export function parseQrContent(content: string): QrParseResult {
  const text = (content ?? '').trim();
  if (!text) return { kind: 'unknown', text: '' };

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const request = paymentRequestFromJson(value as Record<string, unknown>);
        if (request) return { kind: 'payment', request };
      }
    } catch {
      // Not JSON — fall through to the other classifiers.
    }
  }

  if (isWebUrl(text)) return { kind: 'url', url: text };

  if (isAddressLike(text)) return { kind: 'payment', request: { address: text } };

  return { kind: 'unknown', text };
}
