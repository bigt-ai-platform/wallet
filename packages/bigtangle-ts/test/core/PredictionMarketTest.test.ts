import { describe, test, expect } from "vitest";
import {
  PredictionAction,
  PredictionMarketConfig,
} from "../../src/net/bigtangle/apps/prediction/PredictionMarket";
import { PredictionMarketOrders } from "../../src/net/bigtangle/apps/prediction/PredictionMarketOrders";

describe("PredictionMarketTest", () => {
  test("action JSON builders", () => {
    expect(JSON.parse(PredictionAction.create())).toEqual({ action: "create" });
    expect(JSON.parse(PredictionAction.split())).toEqual({ action: "split" });
    expect(JSON.parse(PredictionAction.merge())).toEqual({ action: "merge" });
    expect(JSON.parse(PredictionAction.redeem())).toEqual({ action: "redeem" });
    expect(JSON.parse(PredictionAction.resolve("yes"))).toEqual({
      action: "resolve",
      outcome: "yes",
    });
    expect(JSON.parse(PredictionAction.resolve("invalid"))).toEqual({
      action: "resolve",
      outcome: "invalid",
    });
    expect(JSON.parse(PredictionAction.dispute("no"))).toEqual({
      action: "dispute",
      outcome: "no",
    });
    expect(JSON.parse(PredictionAction.vote("yes"))).toEqual({
      action: "vote",
      outcome: "yes",
    });
    expect(JSON.parse(PredictionAction.propose("invalid"))).toEqual({
      action: "resolve",
      outcome: "invalid",
    });
    expect(JSON.parse(PredictionAction.heartbeat(1700000000))).toEqual({
      action: "heartbeat",
      resolutionTimeSec: 1700000000,
    });
  });

  test("config key-values", () => {
    const tkv = PredictionMarketConfig.keyValues({
      supply: 1000000n,
      collateralTokenid: "bc",
      yesTokenid: "aa",
      noTokenid: "bb",
      question: "will it rain?",
      resolutionTimeSec: 1700000000,
      disputeWindowSec: 300,
      autoInvalidSec: 86400,
      disputeBond: 0n,
      committeeAddresses: ["addr1", "addr2", "addr3"],
    });
    const map = new Map<string, string>();
    for (const kv of tkv.getKeyvalues()!) {
      map.set(kv.getKey(), kv.getValue());
    }
    expect(map.get("classname")).toBe(
      "net.bigtangle.server.service.PredictionContract"
    );
    expect(map.get("S")).toBe("1000000");
    expect(map.get("collateralTokenid")).toBe("bc");
    expect(map.get("yesTokenid")).toBe("aa");
    expect(map.get("noTokenid")).toBe("bb");
    expect(map.get("question")).toBe("will it rain?");
    expect(map.get("resolutionTimeSec")).toBe("1700000000");
    expect(map.get("disputeWindowSec")).toBe("300");
    expect(map.get("autoInvalidSec")).toBe("86400");
    expect(map.get("disputeBond")).toBe("0");
    expect(map.get("oracle")).toBe("committee");
    expect(map.get("committee")).toBe("addr1,addr2,addr3");
  });

  test("staked-market config key-values", () => {
    const tkv = PredictionMarketConfig.keyValues({
      supply: 1000n,
      collateralTokenid: "bc",
      yesTokenid: "aa",
      noTokenid: "bb",
      question: "staked?",
      resolutionTimeSec: 10,
      disputeWindowSec: 300,
      autoInvalidSec: 600,
      disputeBond: 100n,
      proposalBond: 500n,
      voteWindowSec: 60,
    });
    const map = new Map<string, string>();
    for (const kv of tkv.getKeyvalues()!) {
      map.set(kv.getKey(), kv.getValue());
    }
    expect(map.get("oracle")).toBe("staked");
    expect(map.get("committee")).toBeUndefined();
    expect(map.get("proposalBond")).toBe("500");
    expect(map.get("voteWindowSec")).toBe("60");
  });

  test("multi-outcome config key-values", () => {
    const tkv = PredictionMarketConfig.keyValues({
      supply: 1000n,
      collateralTokenid: "bc",
      outcomeTokenids: ["tok-a", "tok-b", "tok-c"],
      outcomeNames: ["Home", "Draw", "Away"],
      question: "which one?",
      resolutionTimeSec: 10,
      disputeWindowSec: 300,
      autoInvalidSec: 600,
      disputeBond: 0n,
      committeeAddresses: ["addr1", "addr2"],
    });
    const map = new Map<string, string>();
    for (const kv of tkv.getKeyvalues()!) {
      map.set(kv.getKey(), kv.getValue());
    }
    expect(map.get("outcomeTokenids")).toBe("tok-a,tok-b,tok-c");
    expect(map.get("outcomeNames")).toBe("Home,Draw,Away");
    expect(map.get("yesTokenid")).toBeUndefined();
    expect(map.get("noTokenid")).toBeUndefined();
  });

  test("multi-outcome requires at least two outcomes", () => {
    expect(() =>
      PredictionMarketConfig.keyValues({
        supply: 1000n,
        collateralTokenid: "bc",
        outcomeTokenids: ["only-one"],
        question: "q",
        resolutionTimeSec: 10,
        disputeWindowSec: 300,
        autoInvalidSec: 600,
        disputeBond: 0n,
        committeeAddresses: ["a", "b"],
      })
    ).toThrow();
  });

  test("market-order planBuy crosses the ask ladder", () => {
    // unsorted asks; planBuy must walk lowest price first
    const asks = [
      { price: 60n, amount: 100n },
      { price: 55n, amount: 50n },
      { price: 57n, amount: 80n },
    ];
    const plan = PredictionMarketOrders.planBuy(asks, 100n);
    // 50 @55 + 50 @57 => worst price 57
    expect(plan).toEqual({ price: 57n, filled: 100n, available: 230n, complete: true });
  });

  test("market-order planBuy reports partial fill when the book is thin", () => {
    const plan = PredictionMarketOrders.planBuy([{ price: 55n, amount: 30n }], 100n);
    expect(plan).toEqual({ price: 55n, filled: 30n, available: 30n, complete: false });
  });

  test("market-order planSell crosses the bid ladder high-to-low", () => {
    const bids = [
      { price: 52n, amount: 40n },
      { price: 54n, amount: 60n },
      { price: 50n, amount: 200n },
    ];
    const plan = PredictionMarketOrders.planSell(bids, 90n);
    // 60 @54 + 30 @52 => worst price 52
    expect(plan).toEqual({ price: 52n, filled: 90n, available: 300n, complete: true });
  });

  test("market-order empty book / zero amount never throws", () => {
    expect(PredictionMarketOrders.planBuy([], 100n)).toEqual({
      price: 0n,
      filled: 0n,
      available: 0n,
      complete: false,
    });
    expect(PredictionMarketOrders.planSell([{ price: 10n, amount: 5n }], 0n)).toEqual({
      price: 0n,
      filled: 0n,
      available: 5n,
      complete: false,
    });
  });

  test("config key-values round-trip through serialization", () => {
    const tkv = PredictionMarketConfig.keyValues({
      supply: 500n,
      collateralTokenid: "bc",
      yesTokenid: "aa",
      noTokenid: "bb",
      question: "q",
      resolutionTimeSec: 1,
      disputeWindowSec: 2,
      autoInvalidSec: 3,
      disputeBond: 4n,
      committeeAddresses: ["x", "y"],
    });
    const bytes = tkv.toByteArray();
    const parsed = (tkv.constructor as any).parse(bytes);
    const map = new Map<string, string>();
    for (const kv of parsed.getKeyvalues()!) {
      map.set(kv.getKey(), kv.getValue());
    }
    expect(map.get("S")).toBe("500");
    expect(map.get("committee")).toBe("x,y");
  });
});
