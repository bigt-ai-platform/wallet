/**
 * Rail-entry extraction (docs/p2p.md §12).
 *
 * A party authorizes an agent on their own device (mobile-mcp) to open the
 * matching entry in their own rail app — the buyer's sending record, the
 * seller's receiving record — and this module is the pure part: turn the
 * accessibility elements into the entry fields the verdict states. Every
 * value here is *observed*, never trusted; `validatePaymentVerdict`
 * (p2p-protocol) decides what the entry may claim against the swap.
 *
 * All three rails show the same facts (§4): exact amount, counterparty,
 * 备注/附言, the entry's own 流水号/交易号, and its timestamp. Only the labels
 * differ, so extraction is label tables, not per-app flows. Timestamps parse
 * in the reading device's local time — the worker runs on the user's own
 * machine/device, whose clock and timezone are the rail app's own.
 */
import type { PaymentVerdict, VerdictExpectation, VerifyEvidenceKind, VerifySide } from "p2p-protocol";

export const RAILS = ["wechat", "alipay", "bank"] as const;
export type Rail = (typeof RAILS)[number];

/** One accessibility node, as the device gateway reports it. */
export interface UiElement {
  text?: string;
  label?: string;
  value?: string;
  role?: string;
}

/** What the rail's own ledger shows for one transfer. */
export interface ParsedEntry {
  /** Decimal string exactly as displayed ("¥715.00" → "715.00"). */
  amount?: string;
  /** The entry's own 流水号 / 交易号 — the correlation id both apps display. */
  txId?: string;
  /** The 备注/附言 the entry carries. */
  remark?: string;
  /** Account name/nickname shown as the counterparty (PII: store-only). */
  counterpartyName?: string;
  /** When the rail timestamps the entry (unix ms, device-local reading). */
  paidAt?: number;
  /** The rail says the transfer settled; undefined when no status is visible. */
  succeeded?: boolean;
}

/** WeChat / Alipay / bank labels for the same facts (§4). */
const TXID_LABEL: Record<Rail, RegExp> = {
  wechat: /微信支付交易单号|商户单号|交易单号|订单号/,
  alipay: /支付宝交易号|商家订单号|交易单号|订单号/,
  bank: /交易流水号|流水号|交易单号|凭证号/,
};
const REMARK_RE = /备注|附言|摘要|留言/;
const COUNTERPARTY_RE = /收款方(?:姓名|名称|账户)?|收款人(?:姓名|名称)?|对方(?:户名|姓名)?|转账给|付给|收款账号/;
const AMOUNT_HINT_RE = /金额|¥|￥|CNY|RMB|支出|收入|转账|付款|收款/;
const DATE_RE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
const TIME_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const OK_RE = /成功|已到账|已完成|完成|到账|入账|已收/;
const FAIL_RE = /失败|关闭|已关闭|退款|撤销|未成功/;

function linesOf(elements: readonly UiElement[]): string[] {
  const out: string[] = [];
  for (const el of elements) {
    for (const v of [el.text, el.label, el.value]) {
      if (typeof v !== "string" || !v.trim()) continue;
      for (const line of v.split(/\n+/)) {
        if (line.trim()) out.push(line.trim());
      }
    }
  }
  return out;
}

/** The value after a label on the same line ("备注: p2p-…" → "p2p-…"). */
function afterLabel(line: string, label: RegExp): string | undefined {
  const m = line.match(label);
  if (!m) return undefined;
  const rest = line.slice((m.index ?? 0) + m[0].length).replace(/^[\s:：=·]+/, "").trim();
  return rest || undefined;
}

function findAmount(lines: readonly string[]): string | undefined {
  // Prefer lines that announce money; fall back to any money token that is not
  // part of a date/time or an id (a "2026-10-13 14:32" must never parse as an
  // amount, nor a 19-digit card number).
  const candidates = [
    ...lines.filter((l) => AMOUNT_HINT_RE.test(l)),
    ...lines.filter((l) => !AMOUNT_HINT_RE.test(l) && !DATE_RE.test(l)),
  ];
  for (const line of candidates) {
    if (/(账号|卡号|账户|订单号|流水号|单号|电话|手机)/.test(line)) continue;
    const cleaned = line.replace(TIME_RE, " ").replace(DATE_RE, " ").replace(/\d{9,}/g, " ");
    const m = cleaned.match(/[-+]?\d+(?:,\d{3})*(?:\.\d{1,2})?/);
    if (!m) continue;
    // "-715.00" (Alipay outflow) and "¥715.00" are the same money.
    const amount = m[0].replace(/^[+-]/, "").replace(/,/g, "");
    if (amount.split(".")[0].length <= 10) return amount;
  }
  return undefined;
}

function findTime(lines: readonly string[]): number | undefined {
  for (const line of lines) {
    const m = line.match(TIME_RE);
    if (!m) continue;
    const [, y, mo, d, h, mi, s] = m;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)).getTime();
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Parse one rail entry screen (or entry row) into its fields. */
export function parseRailEntry(elements: readonly UiElement[], rail: Rail): ParsedEntry | null {
  const lines = linesOf(elements);
  const entry: ParsedEntry = {};
  for (const line of lines) {
    const txId = afterLabel(line, TXID_LABEL[rail]);
    if (txId && /^[A-Za-z0-9._-]{1,64}$/.test(txId) && !entry.txId) entry.txId = txId;
    const remark = afterLabel(line, REMARK_RE);
    if (remark && !entry.remark) entry.remark = remark.slice(0, 128);
    const counterparty = afterLabel(line, COUNTERPARTY_RE);
    if (counterparty && !entry.counterpartyName) entry.counterpartyName = counterparty.slice(0, 128);
  }
  entry.amount = findAmount(lines);
  entry.paidAt = findTime(lines);
  const all = lines.join(" ");
  if (FAIL_RE.test(all)) entry.succeeded = false;
  else if (OK_RE.test(all)) entry.succeeded = true;
  if (entry.amount === undefined) delete entry.amount;
  if (entry.paidAt === undefined) delete entry.paidAt;
  const meaningful = entry.txId || entry.amount || entry.counterpartyName || entry.paidAt !== undefined;
  return meaningful ? entry : null;
}

export interface VerifySpec {
  /** Whose ledger is read — buyer's sending record or seller's receiving record. */
  side: VerifySide;
  rail: Rail;
  /** The swap terms to check the entry against (docs/p2p.md §12). */
  expected: VerdictExpectation;
  evidenceKind?: VerifyEvidenceKind;
  /** bank_ereceipt only: the 回单 verification passed on the bank's public page. */
  receiptVerified?: boolean;
  /** sha256 of the captures kept while reading (audit refs, bytes stay on device). */
  captures?: string[];
}

/**
 * The verdict this entry supports. A missing entry — or an entry the rail
 * marks failed — is `observed: "none"`: "my ledger shows no settled transfer
 * in the window", which is itself evidence (the seller's non-receipt claim,
 * the buyer's failed-send claim).
 */
export function verdictFromEntry(entry: ParsedEntry | null, spec: VerifySpec): PaymentVerdict {
  const evidenceKind = spec.evidenceKind ?? "device_read";
  const base: PaymentVerdict = {
    side: spec.side,
    observed: "none",
    evidenceKind,
    ...(evidenceKind === "bank_ereceipt" ? { receiptVerified: spec.receiptVerified === true } : {}),
    ...(spec.captures?.length ? { captures: spec.captures } : {}),
  };
  if (!entry || entry.succeeded === false) return base;
  return {
    ...base,
    observed: spec.side === "buyer" ? "sent" : "received",
    ...(entry.txId ? { txId: entry.txId } : {}),
    ...(entry.amount ? { amount: entry.amount } : {}),
    ...(entry.counterpartyName ? { counterpartyName: entry.counterpartyName } : {}),
    ...(entry.remark ? { remark: entry.remark } : {}),
    ...(entry.paidAt !== undefined ? { paidAt: entry.paidAt } : {}),
  };
}
