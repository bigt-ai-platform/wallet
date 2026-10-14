/**
 * Receipt-notification reader (docs/p2p.md §12).
 *
 * WeChat (and some rail apps) hide their window from the Android accessibility
 * tree, so the on-screen read (`extract.ts`) returns nothing. But the payee's
 * phone still receives the provider's own **"收款到账" push notification**, and
 * the notification shade *is* readable via the on-phone MCP endpoint
 * (`notification_list`). This module turns one such notification into the same
 * `ParsedEntry` the on-screen reader produces, so both feed one verifier.
 *
 * The provider generates the notification on the **payee's** device, so it is a
 * payee-side signal (the right side to read); like every device read it is
 * *observed*, never trusted — `validatePaymentVerdict` (p2p-protocol) decides
 * what it may claim against the swap.
 */
import type { DeviceNotification } from "mobile-control";
import type { ParsedEntry, Rail, VerifySpec } from "./extract.js";

/** Package → rail, for notifications that carry an amount but no label. */
const RAIL_BY_PACKAGE: ReadonlyArray<readonly [RegExp, Rail]> = [
  [/com\.tencent\.mm/i, "wechat"],
  [/alipay/i, "alipay"],
  [/bank|unionpay|sparkasse|comdirect|n26|revolut|icbc/i, "bank"],
];

/** Detect the rail from the notification's package or text. */
export function detectRail(n: DeviceNotification): Rail | null {
  for (const [re, rail] of RAIL_BY_PACKAGE) if (re.test(n.packageName)) return rail;
  const all = [n.title, n.text, n.bigText, n.subText].filter(Boolean).join(" ");
  if (/微信支付|微信|WeChat/i.test(all)) return "wechat";
  if (/支付宝|Alipay/i.test(all)) return "alipay";
  return null;
}

function linesOf(n: DeviceNotification): string[] {
  const out: string[] = [];
  for (const v of [n.title, n.text, n.bigText, n.subText]) {
    if (typeof v !== "string" || !v.trim()) continue;
    for (const line of v.split(/\n+/)) if (line.trim()) out.push(line.trim());
  }
  return out;
}

/** The first money token: `¥715.00` / `715.00元` / `CNY 715` (never a date/id). */
function findAmount(text: string): string | undefined {
  const m =
    text.match(/[¥￥]\s*([0-9][0-9,]*(?:\.\d{1,2})?)/) ??
    text.match(/([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:元|CNY|RMB)/i);
  if (!m) return undefined;
  const amount = m[1].replace(/,/g, "");
  return amount.split(".")[0].length <= 10 ? amount : undefined;
}

/**
 * Parse one notification into a rail entry, or null when it is not a rail
 * receipt for [rail]. Passing [rail] filters strictly (e.g. it will not accept
 * an Alipay push while reading the WeChat rail).
 */
export function parseReceiptNotification(
  n: DeviceNotification,
  rail?: Rail,
): { rail: Rail; entry: ParsedEntry } | null {
  const detected = detectRail(n);
  if (!detected) return null;
  if (rail && detected !== rail) return null;

  const all = linesOf(n).join(" \n ");
  const entry: ParsedEntry = {};

  const amount = findAmount(all);
  if (amount) entry.amount = amount;

  const txId = all.match(/(?:交易单号|交易号|订单号|流水号|凭证号)\s*[:：]?\s*([A-Za-z0-9._-]{4,64})/);
  if (txId) entry.txId = txId[1];

  const remark = all.match(/(?:备注|附言|留言)\s*[:：]?\s*([^\s，,。;；|]+)/);
  if (remark) entry.remark = remark[1].slice(0, 128);

  const counterparty = all.match(/(?:来自|付款方|转账来自|收款来自)\s*[:：]?\s*([^\s，,。;；|]+)/);
  if (counterparty) entry.counterpartyName = counterparty[1].slice(0, 128);

  if (n.timestampMs !== undefined) entry.paidAt = n.timestampMs;

  if (/失败|退款|撤销|未成功|已退回/.test(all)) entry.succeeded = false;
  else if (/收款到账|已到账|到账|已收款|收款成功|成功收款|已存入|收入/.test(all)) entry.succeeded = true;

  return { rail: detected, entry };
}

/** Compare two decimal money strings ignoring trailing zeros ("715" == "715.00"). */
function moneyEq(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a === b;
}

/**
 * Pick the receipt notification that answers [spec]: the right rail, inside the
 * swap window, with the exact amount when one is expected. Most recent wins.
 */
export function selectReceiptNotification(
  notifications: readonly DeviceNotification[],
  spec: VerifySpec,
): ParsedEntry | null {
  const { paidFrom, paidTo, amount } = spec.expected;
  const entries = notifications
    .map((n) => parseReceiptNotification(n, spec.rail))
    .filter((r): r is { rail: Rail; entry: ParsedEntry } => r !== null)
    .map((r) => r.entry)
    .filter((e) => e.paidAt === undefined || (e.paidAt >= paidFrom && e.paidAt <= paidTo))
    .sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0));

  if (amount) {
    const exact = entries.find((e) => e.amount !== undefined && moneyEq(e.amount, amount));
    return exact ?? null; // an amount mismatch is "no matching receipt", not a wrong one
  }
  return entries[0] ?? null;
}
