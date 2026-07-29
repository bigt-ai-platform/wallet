import { beforeEach, describe, expect, test } from "vitest";
import { RemoteTest, createKeyFromHex } from "./RemoteTest";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { Address } from "../../src/net/bigtangle/core/Address";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";

async function fundKey(k: PQKey, url: string): Promise<void> {
  await fetch(url + "fundAddresses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [{
        address: k.toAddressHex(),
        value: 10000000000,
        pubkey: Utils.HEX.encode(k.getPrefixedPublicKeyBytes()),
      }],
    }),
  });
}

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
    const tokenname = '';
    const result = await wallet.searchToken(tokenname);
    expect(result).toHaveProperty('tokenList');
    expect(result).toHaveProperty('amountMap');
    expect(Array.isArray(result.tokenList)).toBe(true);
    console.log('searchToken result:', result);

    if (result && Array.isArray(result.tokenList)) {
      const tokens: Token[] = result.tokenList.map((t: any) => ({
        tokenid: t.tokenid,
        tokenname: t.tokenname, 
        decimals: t.decimals ?? 8,
        balance: undefined,
      }));
    }
  });


  beforeEach(async () => {
    wallet = Wallet.fromKeysURL(
      TestParams.get(),
      [createKeyFromHex(
        "ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f"
      )],
      serverUrl
    );
    // Fund the wallet key
    const keys = await wallet.walletKeys(null);
    if (keys.length > 0) {
      await fundKey(keys[0], serverUrl);
      await new Promise(r => setTimeout(r, 10000));
    }
  });

  test('should pay to an address using payToList', async () => {
    const quantity = '1';
    const decimals = 8;
    const tokenid = 'bc';

    const amountInSmallestUnit = BigInt(
      Math.floor(Number.parseFloat(quantity) * Math.pow(10, decimals)),
    );

    const tokenIdBuffer = Buffer.from(Utils.HEX.decode(tokenid));

    const giveMoneyResult = new Map<string, bigint>();
    const key = (await wallet.walletKeys(null))[0];
    const address = Address.fromKey(wallet.getNetworkParameters(), key).toString();
    giveMoneyResult.set(address, amountInSmallestUnit);

    const block = await wallet.payToList(
      null,
      giveMoneyResult,
      tokenIdBuffer,
      'test',
    );

    if (!block) {
      throw new Error('Failed to create payment transaction');
    }

    const txHashStr = block.getHashAsString();
    expect(txHashStr).toBeDefined();
    console.log(`Payment transaction hash: ${txHashStr}`);
  });
});
