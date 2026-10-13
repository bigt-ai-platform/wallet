import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("p2p-verify CLI arguments", () => {
  it("accepts a full verification invocation", () => {
    const { options, errors } = parseCliArgs([
      "--side",
      "buyer",
      "--rail",
      "wechat",
      "--amount",
      "715",
      "--remark",
      "p2p-9f3a",
      "--tx-id",
      "4200001234567890",
      "--device",
      "emulator-5554",
      "--app",
      "com.tencent.mm",
    ]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      mode: "verify",
      side: "buyer",
      rail: "wechat",
      amount: "715",
      remark: "p2p-9f3a",
      txId: "4200001234567890",
      device: "emulator-5554",
      app: "com.tencent.mm",
      evidence: "device_read",
      receiptVerified: false,
    });
  });

  it("requires side, rail and amount for a verification", () => {
    const { errors } = parseCliArgs([]);
    expect(errors).toEqual(["--side is required", "--rail is required", "--amount is required"]);
  });

  it("rejects bad enums and dangling values", () => {
    expect(parseCliArgs(["--side", "payer", "--rail", "wechat", "--amount", "1"]).errors).toEqual([
      "--side must be buyer|seller",
    ]);
    expect(parseCliArgs(["--side", "buyer", "--rail", "paypal", "--amount", "1"]).errors).toEqual([
      "--rail must be wechat|alipay|bank",
    ]);
    expect(parseCliArgs(["--side", "buyer", "--rail", "bank", "--amount"]).errors).toContain("--amount needs a value");
    const unknown = parseCliArgs(["--nope"]).errors;
    expect(unknown).toContain("unknown argument --nope");
  });

  it("supports the listing modes without a verification payload", () => {
    expect(parseCliArgs(["--devices"]).options.mode).toBe("devices");
    expect(parseCliArgs(["--device-env"]).options.mode).toBe("device-env");
  });

  it("passes the bank e-receipt flags through", () => {
    const { options, errors } = parseCliArgs([
      "--side",
      "seller",
      "--rail",
      "bank",
      "--amount",
      "715",
      "--evidence",
      "bank_ereceipt",
      "--receipt-verified",
    ]);
    expect(errors).toEqual([]);
    expect(options.evidence).toBe("bank_ereceipt");
    expect(options.receiptVerified).toBe(true);
  });
});
