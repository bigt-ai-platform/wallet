import { describe, test, beforeEach, expect } from "vitest";
import { RemoteTest, createKeyFromHex } from "./RemoteTest";
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

/**
 * Dev trade bootstrap — SHARED helper between dev.sh and the e2e suites.
 *
 * After a fresh infra reset there is no tradeable token on the chain, so the
 * Buy/Sell/Order screens have nothing to show. This test creates a "devtoken"
 * (deterministic issuer key), mints it to the L1 genesis wallet (seed 0x01,
 * the key the dev.sh web app unlocks) AND the yuan wallet (seed 0x03), then
 * leaves a PARTIAL orderbook open (yuan sells, genesis buys) so the app can
 * trade immediately after every dev.sh up/restart.
 *
 * Runs against the SAME Java infra as every other remote test — dev.sh and
 * e2eremote.sh both invoke it (dev.sh: TEST_L1_URL -> its L1 port).
 */
const DEV_ISSUER_SEED = "77" + "66".repeat(15) + "77"; // deterministic 32-byte issuer
const SELL_AMOUNT = 5000;   // yuan offers this many devtoken
const BUY_AMOUNT = 1000;    // genesis takes this many (leaves 4000 open on yuan's order)
const PRICE = 2n;           // base units of bc per devtoken

class TradeBootstrap extends RemoteTest {
  private l1Url = process.env.TEST_L1_URL || "http://localhost:18086/";

  constructor() {
    super();
    // Like RemoteOrderTests: all wallet/funding/order ops run on the L1-order
    // server; token creation blocks are made with the genesis wallet (L0).
    this.contextRoot = this.l1Url;
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

  private async createDevToken(
    key: PQKey,
    tokenname: string,
    amount: bigint,
    tokenid: string
  ): Promise<Block> {
    this.wallet.importKey(key);
    const token = new Token();
    token.setTokenid(tokenid);
    token.setTokenname(tokenname);
    token.setDescription("dev bootstrap trade token");
    token.setDecimals(0);
    token.setAmount(amount);
    token.setTokenstop(false); // increment = true -> more can be minted later
    token.setTokentype(TokenType.token);
    const addresses = [new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()))];
    return await this.wallet.createToken(
      key,
      "",
      true,
      token,
      addresses,
      key.getPubKey(),
      new MemoInfo("coinbase")
    );
  }

  private async payTokenFromIssuer(
    issuer: PQKey,
    recipient: PQKey,
    tokenid: string,
    amount: bigint
  ): Promise<void> {
    const w = await Wallet.fromKeysURL(this.networkParameters, [issuer], this.contextRoot);
    w.setServerURL(this.contextRoot);
    const give = new Map<string, bigint>();
    give.set(Address.fromKey(this.networkParameters, recipient).toString(), amount);
    const tokenidBytes = Buffer.from(Utils.HEX.decode(tokenid));
    await w.payToList(null, give, tokenidBytes, "dev bootstrap");
  }

  async testBootstrapTradeForDev() {
    const bcToken = NetworkParameters.BIGTANGLE_TOKENID_STRING;

    // Deterministic wallets: issuer (owns the token), yuan (seed 0x03) and the
    // genesis wallet (seed 0x01, this.wallet) — all funded with bc on L1.
    const issuer = createKeyFromHex(DEV_ISSUER_SEED);
    const yuanKey = PQKey.fromMLDSA(new Uint8Array(32).fill(0x03));

    const fee = CoinConstants.FEE_DEFAULT.getValue();
    const issuerWallet = await Wallet.fromKeysURL(this.networkParameters, [issuer], this.contextRoot);

    console.log("[bootstrap] funding issuer and yuan with bc on L1...");
    await this.payBigTo([issuer], fee * BigInt(500), []);
    await this.waitForConfirmedBalance(bcToken, [issuer]);
    await this.payBigTo([yuanKey], fee * BigInt(500), []);
    await this.waitForConfirmedBalance(bcToken, [yuanKey]);

    // Create the dev token (L0 genesis wallet provides the domain signature).
    const tokenName = "devtoken";
    const supply = BigInt(10000000);
    const tokenid = Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    console.log("[bootstrap] creating devtoken...");
    await this.createDevToken(issuer, tokenName, supply, tokenid);

    const walletKeys2 = await this.wallet.walletKeys(null);
    let signed: Block | null = null;
    for (let attempt = 0; attempt < 10 && signed == null; attempt++) {
      signed = await this.wallet.multiSign(tokenid, walletKeys2[0], null);
      if (signed == null) {
        console.log(`[bootstrap] multiSign attempt ${attempt + 1} null, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    expect(signed, "devtoken should be multi-signed by the root domain wallet").not.toBeNull();

    let found: Token | null = null;
    for (let i = 0; i < 40; i++) {
      found = await this.getToken(tokenid);
      if (found != null) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(found, "devtoken should be visible on the L1 order chain").not.toBeNull();

    // Wait for the issuer's minted supply to be confirmed, then hand tokens to
    // the genesis wallet (the app's dev wallet) and the yuan wallet. The token
    // creation spends the issuer's bc for fees, so wait for that change to
    // confirm again before each token transfer pays its own bc fee.
    await this.waitForConfirmedBalance(tokenid, [issuer]);
    await this.waitForConfirmedBalance(bcToken, [issuer]);
    console.log("[bootstrap] moving devtoken to genesis + yuan wallets...");
    const genesisAddrKey = PQKey.fromMLDSA(new Uint8Array(32).fill(0x01));
    await this.payTokenFromIssuer(issuer, genesisAddrKey, tokenid, BigInt(2000));
    await this.waitForConfirmedBalance(tokenid, [genesisAddrKey]);
    await this.waitForConfirmedBalance(bcToken, [issuer]);
    await this.payTokenFromIssuer(issuer, yuanKey, tokenid, BigInt(8000));
    await this.waitForConfirmedBalance(tokenid, [yuanKey]);
    console.log("[bootstrap] genesis + yuan both hold confirmed devtoken");

    // Open a partial orderbook: yuan sells, genesis buys the smaller slice.
    console.log(`[bootstrap] yuan sells ${SELL_AMOUNT} devtoken @ ${PRICE}...`);
    const yuanWallet = await Wallet.fromKeysURL(this.networkParameters, [yuanKey], this.contextRoot);
    yuanWallet.setServerURL(this.contextRoot);
    await yuanWallet.sellOrder(null, tokenid, PRICE, BigInt(SELL_AMOUNT), null, null, bcToken, true);
    await new Promise((resolve) => setTimeout(resolve, 4000));

    console.log(`[bootstrap] genesis buys ${BUY_AMOUNT} devtoken @ ${PRICE}...`);
    issuerWallet.setServerURL(this.contextRoot);
    await this.wallet.buyOrder(null, tokenid, PRICE, BigInt(BUY_AMOUNT), null, null, bcToken, true);
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // Verify a sell order is still open (yuan's remainder) and that the app
    // wallet received devtoken from the fill.
    let openSell = false;
    const requestParam = {};
    for (let i = 0; i < 40; i++) {
      const resp = await OkHttp3Util.post(
        this.l1Url + ReqCmd.getOrders,
        new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
      );
      const parsed = JSON.parse(resp);
      const orders: any[] = parsed.allOrdersSorted || [];
      if (orders.some((o) => o.offerTokenid === tokenid)) {
        openSell = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(openSell, "yuan's remainder sell order should still be open").toBe(true);

    let genesisHasToken = false;
    for (let i = 0; i < 30; i++) {
      const utxos = await this.getBalanceByKey(false, genesisAddrKey);
      if (utxos.some((u) => u.getTokenId() === tokenid && u.getValue()!.getValue() > BigInt(0))) {
        genesisHasToken = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(genesisHasToken, "the app genesis wallet should hold confirmed devtoken").toBe(true);
    console.log("[bootstrap] devtoken minted + orderbook ready for dev trade testing");
  }
}

describe("TradeBootstrap (dev)", () => {
  const tests = new TradeBootstrap();

  beforeEach(async () => {
    await tests.setUp();
  });

  test("testBootstrapTradeForDev", async () => {
    await tests.testBootstrapTradeForDev();
  }, 300000);
});
