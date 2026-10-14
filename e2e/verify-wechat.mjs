#!/usr/bin/env node
/**
 * verifyWeChat — read a WeChat (or Alipay/bank) bill on the user's **own** phone
 * through the `android-remote-control-mcp` endpoint and verify it
 * (docs/p2p.md §12). Nothing is mocked: it talks to the real on-phone MCP
 * server the user paired (endpoint + token).
 *
 *   node e2e/verify-wechat.mjs --http http://127.0.0.1:18080 --token <token> \
 *       --rail wechat --app com.tencent.mm --side buyer \
 *       --amount 715 --remark p2p-9f3a --tx-id 4200001234567890
 *
 * No --amount  -> read-only: print the parsed entry and exit 0.
 * With --amount -> run the engine's check; exit 0 on match, 2 on mismatch.
 *
 * NOTE: WeChat hides its window from the Android accessibility tree on some
 * builds, so `listElements()` yields nothing and entry is null. Alipay and most
 * bank apps expose it. --capture also takes a screenshot (sha256 audit ref).
 */
import { AndroidMcpClient } from "mobile-control";
import { parseRailEntry, parseReceiptNotification, verifyPayment, verifyPaymentViaNotification } from "p2p-verify";

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (v) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const rail = get("--rail") ?? "wechat";
  if (!["wechat", "alipay", "bank"].includes(rail)) throw new Error(`--rail must be wechat|alipay|bank (got ${rail})`);
  const via = get("--via") ?? "screen";
  if (!["screen", "notification"].includes(via)) throw new Error(`--via must be screen|notification (got ${via})`);
  const amount = get("--amount");
  return {
    http: get("--http"),
    token: get("--token"),
    device: get("--device") ?? "self",
    side: get("--side") ?? "buyer",
    rail,
    via,
    app: get("--app"),
    amount,
    remark: get("--remark"),
    txId: get("--tx-id"),
    fromMs: num(get("--from-ms")),
    toMs: num(get("--to-ms")),
    capture: argv.includes("--capture"),
    readOnly: amount === undefined,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.http) {
    console.error("--http <endpoint> is required (e.g. http://127.0.0.1:18080 after adb forward tcp:18080 tcp:8080)");
    return 1;
  }

  const gateway = await AndroidMcpClient.connect({
    device: args.device,
    baseUrl: args.http,
    ...(args.token ? { token: args.token } : {}),
  });

  try {
    if (args.via === "notification" && args.readOnly) {
      const notes = await gateway.listNotifications();
      const parsed = notes
        .map((n) => ({ n, r: parseReceiptNotification(n, args.rail) }))
        .filter((x) => x.r !== null);
      console.log(
        JSON.stringify(
          { rail: args.rail, notifications: notes.length, entries: parsed.map((x) => ({ package: x.n.packageName, title: x.n.title, entry: x.r.entry })) },
          null,
          2,
        ),
      );
      return 0;
    }

    if (args.via === "screen" && args.app) await gateway.launchApp(args.app);

    if (args.readOnly) {
      const elements = await gateway.listElements();
      const entry = parseRailEntry(elements, args.rail);
      console.log(JSON.stringify({ rail: args.rail, elements: elements.length, entry }, null, 2));
      if (!entry) {
        console.error(
          "no rail entry found on screen: the bill must be open, and the app must expose its accessibility " +
            "tree (WeChat hides it on some builds — use --via notification).",
        );
      }
      return 0;
    }

    const now = Date.now();
    const spec = {
      side: args.side,
      rail: args.rail,
      evidenceKind: "device_read",
      expected: {
        amount: args.amount,
        ...(args.remark ? { remark: args.remark } : {}),
        ...(args.txId ? { claimedTxId: args.txId } : {}),
        paidFrom: args.fromMs ?? now - 24 * 60 * 60 * 1000,
        paidTo: args.toMs ?? now,
      },
    };
    const result =
      args.via === "notification"
        ? await verifyPaymentViaNotification(gateway, spec)
        : await verifyPayment(gateway, spec, { capture: args.capture });
    console.log(JSON.stringify({ entry: result.entry, verdict: result.verdict, check: result.check }, null, 2));
    return result.check.ok ? 0 : 2;
  } finally {
    gateway.close?.();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
