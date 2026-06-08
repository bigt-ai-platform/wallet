import { beforeEach, describe, expect, test } from "vitest";
import { RemoteTest } from "./RemoteTest";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { ECKey } from "../../src/net/bigtangle/core/ECKey";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";

type Token = {
  tokenid: string;
  tokenname: string;
  decimals: number;
  balance?: number;
};

describe('bigtangle wallet pay', () => {
  let wallet: Wallet;
  const serverUrl = process.env.TEST_WALLET_SERVER_URL || process.env.TEST_CONTEXT_ROOT || "http://localhost:8088/";

  test('should search for tokens using searchToken', async () => {
    // This test assumes the wallet is connected to a test server with tokens available
    // You may need to adjust the token name or mock the server for a real test
    const tokenname = '';
    const result = await wallet.searchToken(tokenname);
    expect(result).toHaveProperty('tokenList');
    expect(result).toHaveProperty('amountMap');
    expect(Array.isArray(result.tokenList)).toBe(true);
    // amountMap can be null or a plain object (not a Map)
    // Optionally log for debug
    console.log('searchToken result:', result);

    if (result && Array.isArray(result.tokenList)) {
      // Map tokenList to Token[] and include domainName
      const tokens: Token[] = result.tokenList.map((t: any) => ({
        tokenid: t.tokenid,
        tokenname: t.tokenname, 
        decimals: t.decimals ?? 8,
        balance: undefined, // balance not available from search
      }));
      // Optionally do something with tokens here
    }
  });


  beforeEach(() => {
    wallet = Wallet.fromKeysURL(
      TestParams.get(),
      [ECKey.fromPrivateString(
        "ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f"
      )],
      serverUrl
    );
  });

  test('should pay to an address using payToList', async () => {
    const quantity = '1';
    const decimals = 8;
    const tokenid = 'bc';

    // Parse the amount - convert to smallest unit based on decimals
    const amountInSmallestUnit = BigInt(
      Math.floor(Number.parseFloat(quantity) * Math.pow(10, decimals)),
    );

    // Create token ID buffer
    const tokenIdBuffer = Buffer.from(Utils.HEX.decode(tokenid));

    // Use payToList to send to self (for testing)
    const giveMoneyResult = new Map<string, bigint>();
    const key = (await wallet.walletKeys(null))[0];
    const address = key.toAddress(wallet.getNetworkParameters()).toString();
    giveMoneyResult.set(address, amountInSmallestUnit);

    // Execute the payment using bigtangle-ts wallet.payToList()
    const block = await wallet.payToList(
      null,
      giveMoneyResult,
      tokenIdBuffer,
      'test',
    );

    if (!block) {
      throw new Error('Failed to create payment transaction');
    }

    // Get the block hash as transaction ID
    const txHashStr = block.getHashAsString();
    expect(txHashStr).toBeDefined();
    console.log(`Payment transaction hash: ${txHashStr}`);
  });
});
