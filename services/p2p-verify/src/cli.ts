#!/usr/bin/env node
/**
 * Verify one fiat payment — the buyer's **sent** record or the seller's
 * **received** record — on the user's own device via mobile-mcp
 * (docs/p2p.md §12).
 *
 *   node dist/cli.js --devices
 *   node dist/cli.js --side buyer  --rail wechat --amount 715 --remark p2p-9f3a \
 *       --tx-id 4200001234567890 --device <id> --app com.tencent.mm
 *   node dist/cli.js --side seller --rail bank --amount 715 --remark p2p-9f3a \
 *       --http http://127.0.0.1:8787 --token "$MOBILEMCP_AUTH"
 *
 * The CLI reads, extracts and checks; it prints the verdict for the **wallet**
 * to sign and POST /swaps/:id/verify. It holds no keys and never talks to the
 * engine. Navigation is the user's (or their own agent's): open the bill entry
 * on the phone, then run this — human-paced, user-initiated, never a scraper
 * (§16).
 *
 * By default it drives the workspace sibling `../mobile-mcp` over stdio;
 * `--http` calls a mobile-mcp started with `--listen` on the machine the phone
 * is attached to (its `MOBILEMCP_AUTH` token via `--token`).
 */
import { RAILS, type Rail } from "./extract.js";
import { McpGateway, localMobileMcpEntry, type DeviceGateway } from "./gateway.js";
import { AndroidMcpClient } from "mobile-control";
import { verifyPayment } from "./worker.js";
import {
  AUTO_RELEASE_POLICIES,
  VERIFY_EVIDENCE_KINDS,
  VERIFY_SIDES,
  type VerifyEvidenceKind,
  type VerifySide,
} from "p2p-protocol";

export interface CliOptions {
  mode: "devices" | "verify" | "device-env";
  side?: VerifySide;
  rail?: Rail;
  amount?: string;
  remark?: string;
  txId?: string;
  device?: string;
  app?: string;
  evidence: VerifyEvidenceKind;
  receiptVerified: boolean;
  windowFromMs?: number;
  windowToMs?: number;
  httpUrl?: string;
  token?: string;
}

const USAGE = `p2p-verify — device-side payment verification (docs/p2p.md §12)

  --devices                       list the devices the user may authorize
  --side buyer|seller             whose ledger is read (required)
  --rail wechat|alipay|bank       the rail app (required)
  --amount 715                    expected amount (required)
  --remark CODE                   the swap's remark code
  --tx-id ID                      the claimed 流水号 to cross-check
  --device ID                     mobile-mcp device (default: first available)
  --app PACKAGE                   launch this app before reading
  --evidence device_read|bank_ereceipt   (default device_read)
  --receipt-verified              the bank 回单 verification passed (bank_ereceipt)
  --window-from-ms N --window-to-ms N    paidAt window (default: now-24h .. now)
  --http URL --token TOKEN        use a mobile-mcp --listen endpoint (Streamable HTTP)
  --device-env                    print the resolved mobile-mcp entry and exit

The verdict it prints is what the wallet signs and POSTs to
/swaps/:id/verify; machine confirmation is policy-gated on the engine
(SETTLEMENT_CNY_AUTO_RELEASE_ON: ${AUTO_RELEASE_POLICIES.join("|")}).`;

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Pure argument parsing (exported for tests). */
export function parseCliArgs(argv: readonly string[]): { options: CliOptions; errors: string[] } {
  const errors: string[] = [];
  const options: CliOptions = { mode: "verify", evidence: "device_read", receiptVerified: false };
  const seen = { side: false, rail: false, amount: false };
  const valueOf = (flag: string, i: number): [string | undefined, number] => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      errors.push(`${flag} needs a value`);
      return [undefined, i];
    }
    return [v, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let v: string | undefined;
    switch (arg) {
      case "--devices":
        options.mode = "devices";
        break;
      case "--receipt-verified":
        options.receiptVerified = true;
        break;
      case "--device-env":
        options.mode = "device-env";
        break;
      case "--side":
        seen.side = true;
        [v, i] = valueOf(arg, i);
        if (v !== undefined && !(VERIFY_SIDES as readonly string[]).includes(v)) errors.push(`--side must be ${VERIFY_SIDES.join("|")}`);
        else if (v !== undefined) options.side = v as VerifySide;
        break;
      case "--rail":
        seen.rail = true;
        [v, i] = valueOf(arg, i);
        if (v !== undefined && !(RAILS as readonly string[]).includes(v)) errors.push(`--rail must be ${RAILS.join("|")}`);
        else if (v !== undefined) options.rail = v as Rail;
        break;
      case "--evidence":
        [v, i] = valueOf(arg, i);
        if (v !== undefined && !(VERIFY_EVIDENCE_KINDS as readonly string[]).includes(v)) {
          errors.push(`--evidence must be ${VERIFY_EVIDENCE_KINDS.join("|")}`);
        } else if (v !== undefined) options.evidence = v as VerifyEvidenceKind;
        break;
      case "--amount":
        seen.amount = true;
        [options.amount, i] = valueOf(arg, i);
        break;
      case "--remark":
        [options.remark, i] = valueOf(arg, i);
        break;
      case "--tx-id":
        [options.txId, i] = valueOf(arg, i);
        break;
      case "--device":
        [options.device, i] = valueOf(arg, i);
        break;
      case "--app":
        [options.app, i] = valueOf(arg, i);
        break;
      case "--window-from-ms":
        [v, i] = valueOf(arg, i);
        options.windowFromMs = num(v);
        break;
      case "--window-to-ms":
        [v, i] = valueOf(arg, i);
        options.windowToMs = num(v);
        break;
      case "--http":
        [options.httpUrl, i] = valueOf(arg, i);
        break;
      case "--token":
        [options.token, i] = valueOf(arg, i);
        break;
      default:
        errors.push(`unknown argument ${arg}`);
    }
  }
  if (options.mode === "verify") {
    // "required" only when the flag was never given — an invalid value already
    // reported itself and must not also be called missing.
    if (!seen.side) errors.push("--side is required");
    if (!seen.rail) errors.push("--rail is required");
    if (!seen.amount) errors.push("--amount is required");
  }
  return { options, errors };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { options, errors } = parseCliArgs(argv);
  if (errors.length) {
    console.error(USAGE);
    for (const e of errors) console.error(`error: ${e}`);
    return 1;
  }

  if (options.mode === "device-env") {
    console.log(JSON.stringify({ entry: process.env.MOBILE_MCP_ENTRY?.trim() || localMobileMcpEntry() }, null, 2));
    return 0;
  }

  const gateway: DeviceGateway = options.httpUrl
    ? await AndroidMcpClient.connect({
        device: options.device ?? "self",
        baseUrl: options.httpUrl,
        ...(options.token ? { token: options.token } : {}),
      })
    : await McpGateway.connect({ device: options.device ?? "list" });

  try {
    if (options.mode === "devices") {
      const devices = (await gateway.listDevices?.()) ?? [];
      console.log(JSON.stringify({ devices }, null, 2));
      return 0;
    }

    let device = options.device;
    if (!device) {
      const devices = (await gateway.listDevices?.()) ?? [];
      device = devices[0]?.id;
      if (!device) {
        console.error("no device available — start a simulator/emulator or pass --device (see ../mobile-mcp)");
        return 1;
      }
    }
    if (options.app) await gateway.launchApp(options.app);

    const now = Date.now();
    const result = await verifyPayment(gateway, {
      side: options.side!,
      rail: options.rail!,
      evidenceKind: options.evidence,
      ...(options.evidence === "bank_ereceipt" ? { receiptVerified: options.receiptVerified } : {}),
      expected: {
        amount: options.amount!,
        ...(options.remark ? { remark: options.remark } : {}),
        ...(options.txId ? { claimedTxId: options.txId } : {}),
        paidFrom: options.windowFromMs ?? now - 24 * 60 * 60 * 1000,
        paidTo: options.windowToMs ?? now,
      },
    });

    console.log(JSON.stringify({ verdict: result.verdict, check: result.check, entry: result.entry }, null, 2));
    if (result.check.ok) {
      console.error("next: the wallet signs `verdict` and POSTs it to /swaps/:swapId/verify");
      return 0;
    }
    console.error(`verdict does not match the swap: ${result.check.error ?? "unknown"}`);
    return 2;
  } finally {
    gateway.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
