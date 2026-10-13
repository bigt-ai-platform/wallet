/**
 * The verification worker (docs/p2p.md §12): read the swap's transfer from the
 * party's **own** rail app and produce the signed-verdict payload.
 *
 * Trust model: this worker never decides anything. It extracts what the user's
 * own device shows and validates it against the swap terms (p2p-protocol);
 * the wallet signs the result with the party's DID key, and the engine treats
 * it as policy-gated evidence — "the model never supplies trusted evidence"
 * (§14). Navigation is deliberately not automated: the user (or their own
 * agent) opens the bill entry — the worker reads, extracts and checks it, so
 * no automation trips the rail's risk controls (§16 冻卡).
 */
import { createHash } from "node:crypto";
import {
  validatePaymentVerdict,
  type PaymentVerdict,
  type VerdictCheck,
} from "p2p-protocol";
import { parseRailEntry, verdictFromEntry, type ParsedEntry, type VerifySpec } from "./extract.js";
import type { DeviceGateway } from "./gateway.js";

export interface VerifyOptions {
  /**
   * Bring the entry on screen first (e.g. the agent opens the bill detail).
   * Runs before any read; omitted when the entry is already on screen.
   */
  navigate?: (gateway: DeviceGateway) => Promise<void>;
  /** Take the screenshot capture (default true) — its sha256 is the audit ref. */
  capture?: boolean;
}

export interface VerifyResult {
  /** The verdict the wallet signs and posts to /swaps/:id/verify. */
  verdict: PaymentVerdict;
  /** The engine applies the same check before storing — surfaced here for the UI. */
  check: VerdictCheck;
  /** sha256 of every capture taken while reading (bytes stay on the device). */
  captures: string[];
  /** What was parsed, for the user-facing confirmation screen. */
  entry: ParsedEntry | null;
}

/** Read, extract and check one payment on the user's own device. */
export async function verifyPayment(
  gateway: DeviceGateway,
  spec: VerifySpec,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const captures: string[] = [];
  if (options.navigate) await options.navigate(gateway);
  if (options.capture !== false) {
    const shot = await gateway.screenshot();
    captures.push(createHash("sha256").update(shot).digest("hex"));
  }
  const elements = await gateway.listElements();
  const entry = parseRailEntry(elements, spec.rail);
  const verdict = verdictFromEntry(entry, { ...spec, ...(captures.length ? { captures } : {}) });
  const check = validatePaymentVerdict(verdict, spec.expected);
  return { verdict, check, captures, entry };
}
