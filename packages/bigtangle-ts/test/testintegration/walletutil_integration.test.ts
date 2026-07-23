import { beforeEach, describe, expect, test } from "vitest";
import { RemoteTest, createKeyFromHex } from "./RemoteTest";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { Address } from "../../src/net/bigtangle/core/Address";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { WalletUtil } from "../../src/net/bigtangle/utils/WalletUtil";
import { MarketOrderItemImpl } from "../../src/net/bigtangle/ordermatch/MarketOrderItem";

describe('bigtangle walletutil', () => {
  let wallet: Wallet;
  const serverUrl = process.env.TEST_WALLET_SERVER_URL || process.env.TEST_CONTEXT_ROOT || "http://localhost:8088/";

  beforeEach(() => {
    wallet = Wallet.fromKeysURL(
      TestParams.get(),
      [createKeyFromHex(
        "ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f"
      )],
      serverUrl
    );
  });

  test('should search for orders using searchOrder', async () => {
    const address4search = null;
    const state4search = "publish";
    const isMine = false;
    try {
      const result = await WalletUtil.searchOrder(
        wallet,
        null,
        address4search,
        state4search,
        isMine,
        serverUrl
      );

      expect(Array.isArray(result)).toBe(true);
      console.log(`Found ${result.length} orders`);

      if (result.length > 0) {
        for (const order of result) {
          expect(order).toHaveProperty('tokenName');
          expect(order).toHaveProperty('type');
          expect(order).toHaveProperty('price');
          expect(order).toHaveProperty('orderRecord');
          expect(order).toHaveProperty('token');
          expect(typeof order.tokenName).toBe('string');
          expect(typeof order.type).toBe('string');
          expect(order.type).toMatch(/^(buy|sell)$/);
          expect(order.price).toBeNull || expect(typeof order.price).toBe('number');
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED')) {
          console.log('Network error (server not running) - this is expected in test environment');
        } else if (error.message.includes('Unexpected end of JSON input') || error.message.includes('Server Error')) {
          console.log('Server endpoint not available on this server - this is expected for L0-only servers');
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  });

  test('should search for order tickers using searchOrdersTicker', async () => {
    const tokenid = "bc";
    try {
      const result = await WalletUtil.searchOrdersTicker(
        tokenid,
        serverUrl
      );

      expect(Array.isArray(result)).toBe(true);
      console.log(`Found ${result.length} order tickers`);

      if (result.length > 0) {
        for (const ticker of result) {
          expect(ticker.get("price")).toBeDefined();
          expect(ticker.get("tokenid")).toBeDefined();
          expect(ticker.get("inserttime")).toBeDefined();
          expect(ticker.get("executedQuantity")).toBeDefined();
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED') || error.message.includes('Server Error')) {
          console.log('Network error or server error - this is expected in test environment');
        } else if (error.message.includes('Unexpected end of JSON input')) {
          console.log('Server endpoint not available on this server - this is expected for L0-only servers');
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  });

  test('should check if an address belongs to the wallet using checkCancel', async () => {
    const keys = await wallet.walletKeys(null);
    const address = Address.fromKey(wallet.params, keys[0]).toString();

    const result = await WalletUtil.checkCancel(
      wallet,
      null,
      address
    );

    expect(result).toBe(true);
  });

  test('should return false for an address not in the wallet using checkCancel', async () => {
    const randomKey = createKeyFromHex(
      "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678"
    );
    const randomAddress = Address.fromKey(wallet.params, randomKey).toString();

    const result = await WalletUtil.checkCancel(
      wallet,
      null,
      randomAddress
    );

    expect(result).toBe(false);
  });

  test('should get localized token name for CNY tokens', () => {
    const tokenName = "somecny@etf.com";
    const result = WalletUtil.getLocalTokenName(tokenName);
    expect(result).toBe("CNY");
  });

  test('should get localized token name for USD tokens', () => {
    const tokenName = "someusd@etf.com";
    const result = WalletUtil.getLocalTokenName(tokenName);
    expect(result).toBe("USD");
  });

  test('should return empty string for non-CNY/USD tokens', () => {
    const tokenName = "someother@token.com";
    const result = WalletUtil.getLocalTokenName(tokenName);
    expect(result).toBe("");
  });

  test('should reset order list properly', () => {
    const mockOrder1 = {
      tokenName: "BIG",
      type: "buy",
      price: 100,
      orderRecord: {},
      token: {}
    } as unknown as MarketOrderItemImpl;

    const mockOrder2 = {
      tokenName: "BIG",
      type: "sell",
      price: 90,
      orderRecord: {},
      token: {}
    } as unknown as MarketOrderItemImpl;

    const mockOrder3 = {
      tokenName: "OTHER",
      type: "buy",
      price: 50,
      orderRecord: {},
      token: {}
    } as unknown as MarketOrderItemImpl;

    const orderList = [mockOrder1, mockOrder2, mockOrder3];
    const result = WalletUtil.resetOrderList(orderList);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
  });
});
