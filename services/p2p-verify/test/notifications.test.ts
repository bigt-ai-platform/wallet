import { describe, it, expect } from "vitest";
import type { DeviceNotification } from "mobile-control";
import { detectRail, parseReceiptNotification, selectReceiptNotification } from "../src/notifications.js";
import { verifyPaymentViaNotification } from "../src/worker.js";
import type { DeviceGateway } from "../src/gateway.js";
import type { VerdictExpectation } from "p2p-protocol";

const AT = new Date(2026, 9, 13, 14, 32, 0).getTime();

/** The payee's WeChat "收款到账" push (buyer → seller, docs/p2p.md §12). */
const wechatReceipt: DeviceNotification = {
  packageName: "com.tencent.mm",
  appName: "WeChat",
  title: "微信支付",
  text: "微信支付收款到账 ¥715.00",
  bigText: "微信支付收款到账 ¥715.00，来自 张三，备注 p2p-9f3a，交易单号 4200001234567890",
  timestampMs: AT,
};

/** An Alipay receipt push. */
const alipayReceipt: DeviceNotification = {
  packageName: "com.eg.android.AlipayGphone",
  appName: "Alipay",
  title: "支付宝",
  text: "成功收款 715.00 元",
  bigText: "成功收款 715.00 元，来自 张三，备注 p2p-9f3a",
  timestampMs: AT,
};

const unrelated: DeviceNotification = {
  packageName: "com.android.settings",
  title: "Laden per USB",
  text: "Für weitere Optionen antippen.",
  timestampMs: AT,
};

const expected: VerdictExpectation = {
  amount: "715",
  remark: "p2p-9f3a",
  claimedTxId: "4200001234567890",
  paidFrom: AT - 60_000,
  paidTo: AT + 60_000,
};

describe("receipt-notification reader (docs/p2p.md §12)", () => {
  it("detects the rail from the package or the text", () => {
    expect(detectRail(wechatReceipt)).toBe("wechat");
    expect(detectRail(alipayReceipt)).toBe("alipay");
    expect(detectRail(unrelated)).toBeNull();
  });

  it("parses a WeChat 收款到账 push into the entry fields", () => {
    const parsed = parseReceiptNotification(wechatReceipt, "wechat");
    expect(parsed?.rail).toBe("wechat");
    expect(parsed?.entry).toMatchObject({
      amount: "715.00",
      txId: "4200001234567890",
      remark: "p2p-9f3a",
      counterpartyName: "张三",
      paidAt: AT,
      succeeded: true,
    });
  });

  it("parses an Alipay receipt and rejects a rail mismatch", () => {
    expect(parseReceiptNotification(alipayReceipt, "alipay")?.entry.amount).toBe("715.00");
    expect(parseReceiptNotification(alipayReceipt, "wechat")).toBeNull();
  });

  it("ignores unrelated notifications", () => {
    expect(parseReceiptNotification(unrelated)).toBeNull();
  });

  it("selects the in-window, exact-amount receipt and skips others", () => {
    const old = { ...wechatReceipt, timestampMs: AT - 24 * 60 * 60 * 1000 };
    const wrongAmount = { ...wechatReceipt, text: "微信支付收款到账 ¥1.00", bigText: "微信支付收款到账 ¥1.00", timestampMs: AT };
    const selected = selectReceiptNotification([unrelated, old, wrongAmount, wechatReceipt], {
      side: "seller",
      rail: "wechat",
      expected,
    });
    expect(selected?.amount).toBe("715.00");
    expect(selected?.paidAt).toBe(AT);
  });

  it("returns null when no receipt matches the amount", () => {
    const selected = selectReceiptNotification([unrelated], { side: "seller", rail: "wechat", expected });
    expect(selected).toBeNull();
  });

  it("verifyPaymentViaNotification produces a received verdict the check accepts", async () => {
    const gateway: DeviceGateway = {
      async listApps() {
        return [];
      },
      async launchApp() {},
      async listElements() {
        return [];
      },
      async typeKeys() {},
      async swipe() {},
      async screenshot() {
        return new Uint8Array();
      },
      async listNotifications() {
        return [wechatReceipt];
      },
    };
    const result = await verifyPaymentViaNotification(gateway, {
      side: "seller",
      rail: "wechat",
      evidenceKind: "device_read",
      expected,
    });
    expect(result.check.ok).toBe(true);
    expect(result.verdict).toMatchObject({ side: "seller", observed: "received", txId: "4200001234567890" });
  });
});
