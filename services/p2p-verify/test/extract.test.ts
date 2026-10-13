import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { VerdictExpectation } from "p2p-protocol";
import { parseRailEntry, verdictFromEntry, type UiElement } from "../src/extract.js";
import { verifyPayment } from "../src/worker.js";
import type { DeviceApp, DeviceGateway } from "../src/gateway.js";

const expected: VerdictExpectation = {
  amount: "715",
  remark: "p2p-9f3a",
  claimedTxId: "4200001234567890",
  paidFrom: new Date(2026, 9, 13, 0, 0, 0).getTime(),
  paidTo: new Date(2026, 9, 13, 23, 59, 59).getTime(),
};

/** WeChat bill detail (the buyer's sending record). */
const wechatDetail: UiElement[] = [
  { text: "¥715.00" },
  { text: "转账收款方 张三" },
  { text: "到账时间 2026-10-13 14:32" },
  { text: "备注 p2p-9f3a" },
  { text: "微信支付交易单号 4200001234567890" },
  { text: "支付成功" },
];

/** Bank transfer detail with 附言 (the seller's receiving record). */
const bankDetail: UiElement[] = [
  { text: "交易成功" },
  { text: "转账支出金额 ¥715.00" },
  { text: "收款人 张三" },
  { text: "收款账号 6222020200123456789" },
  { text: "附言 p2p-9f3a" },
  { text: "交易时间 2026-10-13 14:32:05" },
  { text: "交易流水号 20261013143205001234" },
];

/** Alipay detail: outflow shows a signed amount. */
const alipayDetail: UiElement[] = [
  { text: "-715.00" },
  { text: "转账给 张三" },
  { text: "交易时间 2026-10-13 14:32" },
  { text: "备注 p2p-9f3a" },
  { text: "支付宝交易号 2026101322001400123456789012" },
  { text: "交易成功" },
];

/** A failed transfer: the rail says the money did not move. */
const failedSend: UiElement[] = [
  { text: "¥715.00" },
  { text: "转账收款方 张三" },
  { text: "交易时间 2026-10-13 14:32" },
  { text: "转账失败" },
];

function fakeGateway(elements: UiElement[], shot: Uint8Array = new Uint8Array([1, 2, 3])): DeviceGateway {
  return {
    async listApps(): Promise<DeviceApp[]> {
      return [{ id: "com.tencent.mm", name: "WeChat" }];
    },
    async launchApp(): Promise<void> {},
    async listElements(): Promise<UiElement[]> {
      return elements;
    },
    async typeKeys(): Promise<void> {},
    async swipe(): Promise<void> {},
    async screenshot(): Promise<Uint8Array> {
      return shot;
    },
  };
}

describe("rail entry extraction (docs/p2p.md §12)", () => {
  it("reads the buyer's WeChat sending record", () => {
    const entry = parseRailEntry(wechatDetail, "wechat");
    expect(entry).toMatchObject({
      amount: "715.00",
      txId: "4200001234567890",
      remark: "p2p-9f3a",
      counterpartyName: "张三",
      succeeded: true,
    });
    expect(entry!.paidAt).toBe(new Date(2026, 9, 13, 14, 32).getTime());
  });

  it("reads the bank receiving record — the card number is never the amount", () => {
    const entry = parseRailEntry(bankDetail, "bank");
    expect(entry).toMatchObject({
      amount: "715.00",
      txId: "20261013143205001234",
      remark: "p2p-9f3a",
      counterpartyName: "张三",
      succeeded: true,
    });
  });

  it("reads an Alipay outflow (-715.00 is 715.00 sent)", () => {
    const entry = parseRailEntry(alipayDetail, "alipay");
    expect(entry).toMatchObject({ amount: "715.00", remark: "p2p-9f3a", succeeded: true });
  });

  it("a failed transfer and an empty screen both mean 'nothing settled'", () => {
    expect(verdictFromEntry(parseRailEntry(failedSend, "wechat"), { side: "buyer", rail: "wechat", expected })).toMatchObject({
      observed: "none",
    });
    expect(parseRailEntry([{ text: "账单详情" }, { text: "2026-10-13" }], "wechat")).toBeNull();
    expect(verdictFromEntry(null, { side: "seller", rail: "bank", expected })).toMatchObject({
      side: "seller",
      observed: "none",
      evidenceKind: "device_read",
    });
  });

  it("maps direction by side and keeps the capture refs", () => {
    const entry = parseRailEntry(wechatDetail, "wechat")!;
    const buyerVerdict = verdictFromEntry(entry, { side: "buyer", rail: "wechat", expected });
    const sellerVerdict = verdictFromEntry(entry, { side: "seller", rail: "wechat", expected });
    expect(buyerVerdict.observed).toBe("sent");
    expect(sellerVerdict.observed).toBe("received");
    expect(sellerVerdict.side).toBe("seller");
  });
});

describe("the verification worker", () => {
  it("captures, extracts and checks on the user's own device", async () => {
    const shot = new Uint8Array([13, 37]);
    const result = await verifyPayment(fakeGateway(wechatDetail, shot), {
      side: "buyer",
      rail: "wechat",
      expected,
    });
    expect(result.check.ok).toBe(true);
    expect(result.verdict).toMatchObject({
      side: "buyer",
      observed: "sent",
      amount: "715.00",
      remark: "p2p-9f3a",
      txId: "4200001234567890",
    });
    // the capture is an audit ref over the bytes — the bytes stay on device
    expect(result.captures).toEqual([createHash("sha256").update(shot).digest("hex")]);
    expect(result.verdict.captures).toEqual(result.captures);
  });

  it("fails closed when the entry does not match the swap", async () => {
    const wrongRemark = wechatDetail.map((el) =>
      el.text?.startsWith("备注") ? { text: "备注 p2p-ffffffff" } : el,
    );
    const result = await verifyPayment(fakeGateway(wrongRemark), { side: "buyer", rail: "wechat", expected });
    expect(result.check.ok).toBe(false);
    expect(result.check.error).toMatch(/remark/);
  });

  it("reports 'nothing settled' when the ledger shows no matching entry", async () => {
    const result = await verifyPayment(fakeGateway([]), { side: "seller", rail: "wechat", expected }, { capture: false });
    expect(result.verdict.observed).toBe("none");
    expect(result.captures).toEqual([]);
    // the 'none' verdict is valid evidence — the engine stores it
    expect(result.check.ok).toBe(true);
  });

  it("surfaces a 流水号 that differs from the buyer's claim", async () => {
    const other = wechatDetail.map((el) =>
      el.text?.startsWith("微信支付交易单号") ? { text: "微信支付交易单号 9900000000000000" } : el,
    );
    const result = await verifyPayment(fakeGateway(other), { side: "buyer", rail: "wechat", expected });
    expect(result.check.ok).toBe(true);
    expect(result.check.claimMismatch).toEqual({ claimed: "4200001234567890", observed: "9900000000000000" });
  });

  it("runs the navigation hook before reading", async () => {
    const calls: string[] = [];
    const gateway: DeviceGateway = {
      ...fakeGateway(wechatDetail),
      async swipe(direction) {
        calls.push(`swipe:${direction}`);
      },
    };
    await verifyPayment(gateway, { side: "buyer", rail: "wechat", expected }, {
      navigate: async (g) => {
        calls.push("navigate");
        await g.swipe("up");
      },
    });
    expect(calls).toEqual(["navigate", "swipe:up"]);
  });
});
