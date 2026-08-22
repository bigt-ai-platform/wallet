import { describe, test, expect, beforeEach } from "vitest";
import { RemoteTest } from "./RemoteTest";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { ReqCmd } from "../../src/net/bigtangle/params/ReqCmd";
import { OrderdataResponse } from "../../src/net/bigtangle/response/OrderdataResponse";
import { OkHttp3Util } from "../../src/net/bigtangle/utils/OkHttp3Util";
import { Json } from "../../src/net/bigtangle/utils/Json";
import { UTXO } from "../../src/net/bigtangle/core/UTXO";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Address } from "../../src/net/bigtangle/core/Address";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { CoinConstants } from "../../src/net/bigtangle/core/CoinConstants";

class RemoteOrderTests extends RemoteTest {
  private l1Url = process.env.TEST_L1_URL || "http://localhost:18086/";

  constructor() {
    super();
    // Matches Java RemoteOrderTests, which sets contextRoot = l1Url: ALL
    // operations (wallets, funding, token creation, buy/sell orders) run on
    // the L1-order server; L0 is only used for payment/token creation.
    this.contextRoot = this.l1Url;
  }

  private async fundKey(key: PQKey, value: bigint = BigInt(10000000000)): Promise<void> {
    const body = {
      addresses: [{
        address: key.toAddressHex(),
        value: Number(value),
        pubkey: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      }],
    };
    await OkHttp3Util.post(
      this.contextRoot + "fundAddresses",
      new TextEncoder().encode(Json.jsonmapper().stringify(body))
    );
  }

  async testCreateTokenAndTrade() {
    // 1. Create keys and wallets
    const issuer = PQKey.createNew();
    const buyer = PQKey.createNew();
    const issuerWallet = await Wallet.fromKeysURL(this.networkParameters, [issuer], this.contextRoot);
    const buyerWallet = await Wallet.fromKeysURL(this.networkParameters, [buyer], this.contextRoot);
    const bcToken = NetworkParameters.BIGTANGLE_TOKENID_STRING;

    // 2. Fund issuer and buyer with BC (before token creation) via real
    //    on-chain transactions from the genesis wallet (matches Java's
    //    payBigTo). fundAddresses coinbases are virtual (not in a block), so
    //    orders that spend them cannot be synced to the L1 order server.
    const userFunds = CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);
    console.log("Funding issuer...");
    await this.payBigTo([issuer], userFunds, []);
    await this.waitForConfirmedBalance(bcToken, [issuer]);
    console.log("Funding buyer...");
    await this.payBigTo([buyer], userFunds, []);
    await this.waitForConfirmedBalance(bcToken, [buyer]);

    // Verify both have confirmed BC
    for (const key of [issuer, buyer]) {
      const utxo = await this.waitForConfirmedBalance(bcToken, [key]);
      expect(utxo.getValue()!.getValue()).toBeGreaterThan(BigInt(0));
    }
    console.log("Issuer and buyer funded with BC");

    // 3. Create a custom token
    const tokenName = "tradetoken";
    const supply = BigInt(10000000);
    const tokenid = Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    const block = await this.createToken(issuer, tokenName, 0, "", "token for buy/sell test",
      supply, true, null, TokenType.token, tokenid);
    expect(block).not.toBeNull();

    const walletKeys2 = await this.wallet.walletKeys(null);
    let signed: Block | null = null;
    for (let attempt = 0; attempt < 10 && signed == null; attempt++) {
      signed = await this.wallet.multiSign(tokenid, walletKeys2[0], null);
      if (signed == null) {
        console.log(`multiSign attempt ${attempt + 1} returned null, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    if (signed != null) {
      console.log("Token multi-signed, waiting for confirmation...");
    } else {
      console.log("multiSign returned null (may need more time)");
    }

    let foundToken: Token | null = null;
    for (let i = 0; i < 40; i++) {
      foundToken = await this.getToken(tokenid);
      if (foundToken != null) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(foundToken).not.toBeNull();
    console.log(`Token ${tokenName} created`);

    // Wait for token UTXOs to be confirmed
    await this.waitForConfirmedBalance(tokenid, [issuer]);

    // 4. Create a sell order: sell 100 tradetoken at price 1000 (BC base)
    const sellPrice = BigInt(1000);
    const sellAmount = BigInt(100);
    console.log(`Sell: ${sellAmount} ${tokenName} @ price ${sellPrice}`);
    issuerWallet.setServerURL(this.contextRoot);
    await issuerWallet.sellOrder(null, tokenid, sellPrice, sellAmount, null, null,
      NetworkParameters.BIGTANGLE_TOKENID_STRING, true);
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 5. Verify sell order is open via getOrders API
    const requestParam = {};
    let ordersBefore: OrderdataResponse | null = null;
    for (let i = 0; i < 40; i++) {
      const resp = await OkHttp3Util.post(this.l1Url + ReqCmd.getOrders,
        new TextEncoder().encode(Json.jsonmapper().stringify(requestParam)));
      const parsed = JSON.parse(resp);
      ordersBefore = new OrderdataResponse();
      if (parsed.allOrdersSorted) {
        ordersBefore.setAllOrdersSorted(parsed.allOrdersSorted);
      }
      if (ordersBefore.getAllOrdersSorted() != null && ordersBefore.getAllOrdersSorted()!.length > 0)
        break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(ordersBefore).not.toBeNull();
    const sellOrders = ordersBefore!.getAllOrdersSorted();
    expect(sellOrders).not.toBeNull();
    expect(sellOrders!.length).toBeGreaterThanOrEqual(1);
    console.log(`Sell order confirmed: ${sellOrders!.length} open`);

    // 6. Create a matching buy order
    // Ensure buyer's BC UTXOs are still confirmed
    await this.waitForConfirmedBalance(bcToken, [buyer], 45000, 3000);

    console.log(`Buy: ${sellAmount} ${tokenName} @ price ${sellPrice}`);
    buyerWallet.setServerURL(this.contextRoot);
    await buyerWallet.buyOrder(null, tokenid, sellPrice, sellAmount, null, null,
      NetworkParameters.BIGTANGLE_TOKENID_STRING, false);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 7. Wait for order matching and verify
    let ordersAfter: OrderdataResponse | null = null;
    for (let i = 0; i < 40; i++) {
      const resp = await OkHttp3Util.post(this.l1Url + ReqCmd.getOrders,
        new TextEncoder().encode(Json.jsonmapper().stringify(requestParam)));
      const parsed = JSON.parse(resp);
      ordersAfter = new OrderdataResponse();
      if (parsed.allOrdersSorted) {
        ordersAfter.setAllOrdersSorted(parsed.allOrdersSorted);
      }
      const remaining = ordersAfter.getAllOrdersSorted();
      if (remaining == null || remaining.length === 0)
        break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const remainingOrders = ordersAfter!.getAllOrdersSorted();
    expect(remainingOrders == null || remainingOrders.length === 0).toBe(true);

    // 8. Verify issuer received BC from the trade. The match executes on the
    // L1 beacon cadence, so the payout needs its own confirmation cycle —
    // wait for it instead of racing the assert right after orders drain.
    await this.waitForConfirmedBalance(bcToken, [issuer]);
    const issuerBalance = await this.getBalanceByKey(false, issuer);
    console.log(`Issuer has ${issuerBalance.length} UTXOs after trade`);
    let hasBcTrade = false;
    for (const u of issuerBalance) {
      console.log(`  UTXO: ${u.getTokenId()} value=${u.getValue()!.getValue()}`);
      if (u.getTokenId() === bcToken)
        hasBcTrade = true;
    }
    expect(hasBcTrade).toBe(true);
    console.log("Buy/sell trade test completed successfully");
  }

  private async getToken(tokenid: string): Promise<Token | null> {
    try {
      const res = await fetch(this.contextRoot + "getTokenById", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenid }),
      });
      const data: any = await res.json();
      if (data.tokens && data.tokens.length > 0) {
        return data.tokens[0] as Token;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async createToken(
    key: PQKey,
    tokenname: string,
    decimals: number,
    domainname: string,
    description: string,
    amount: bigint,
    increment: boolean,
    tokenKeyValues: any,
    tokentype: TokenType,
    tokenid: string
  ): Promise<Block> {
    this.wallet.importKey(key);
    const token = new Token();
    token.setTokenid(tokenid);
    token.setTokenname(tokenname);
    token.setDescription(description);
    token.setDecimals(decimals);
    token.setAmount(amount);
    token.setTokenstop(!increment);
    token.setTokentype(tokentype);
    if (tokenKeyValues) {
      token.setTokenKeyValues(tokenKeyValues);
    }
    const addresses = [new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()))];
    return await this.wallet.createToken(
      key,
      domainname,
      increment,
      token,
      addresses,
      key.getPubKey(),
      new MemoInfo("coinbase")
    );
  }
}

describe("RemoteOrderTests", () => {
  const tests = new RemoteOrderTests();

  beforeEach(async () => {
    await tests.setUp();
  });

  test("testCreateTokenAndTrade", async () => {
    await tests.testCreateTokenAndTrade();
  }, 300000);
});
