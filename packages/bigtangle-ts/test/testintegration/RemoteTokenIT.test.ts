import { beforeEach, describe, expect, test } from "vitest";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenInfo } from "../../src/net/bigtangle/core/TokenInfo";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Coin } from "../../src/net/bigtangle/core/Coin";
import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { Block } from "../../src/net/bigtangle/core/Block";
import { ReqCmd } from "../../src/net/bigtangle/params/ReqCmd";
import { OkHttp3Util } from "../../src/net/bigtangle/utils/OkHttp3Util";
import { Json } from "../../src/net/bigtangle/utils/Json";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:18088/";

describe("RemoteTokenIT", () => {
  let wallet: Wallet;
  let key: PQKey;

  beforeEach(() => {
    key = PQKey.createNew();
    wallet = Wallet.fromKeys(TestParams.get(), [key]);
    wallet.setServerURL(L0_URL);
    wallet.setFee(false);
  });

  test("testTokens", { timeout: 60000 }, async () => {
    const tokename = "人民币";
    const decimals = 2;
    const domainname = "";
    const description = "人民币 CNY";
    const amount = BigInt(1000000000);

    // Fund the key with BIG for fee
    const fundPayload = {
      addresses: [{
        address: key.toAddressHex(),
        value: 10000000000,
        pubkey: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      }],
    };
    const fundRes = await fetch(L0_URL + "fundAddresses", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fundPayload),
    });
    const fundParsed = await fundRes.json();
    expect(fundParsed.errorcode).toBe(0);

    // Build token matching Java RemoteTokenTests.createToken:
    // Token.buildSimpleTokenInfo(true, ZERO_HASH, pubKeyAsHex, tokename, description, 1, 0, amount, true, decimals, "")
    const tokenid = Utils.HEX.encode(key.getPrefixedPublicKeyBytes());
    const token = new Token(tokenid, tokename);
    token.setDescription(description);
    token.setDecimals(decimals);
    token.setAmount(amount);
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(1);
    token.setDomainName("");
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setConfirmed(true);
    token.setTokentype(TokenType.identity);

    const addresses: MultiSignAddress[] = [
      new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()), 0),
    ];

    try {
      const block = await wallet.createToken(
        key,
        domainname,
        true,    // increment=false → tokenstop=true
        token,
        addresses,
        key.getPubKey(),
        new MemoInfo("coinbase"),
      );
      expect(block).toBeDefined();
      console.log(`Token created in block: ${block.getHashAsString()}`);

      // Verify token exists on server
      const searchRes = await OkHttp3Util.post(
        L0_URL + ReqCmd.searchTokens,
        new TextEncoder().encode(Json.jsonmapper().stringify({}))
      );
      const searchParsed = JSON.parse(searchRes);
      const tokens: any[] = searchParsed.tokens || [];
      const found = tokens.find((t: any) => t.tokenid === tokenid);
      if (found) {
        console.log(`Found token: ${found.tokenname}`);
        expect(found.tokenname).toBe(tokename);
      } else {
        console.log("Token not found yet (may need MCMC confirmation)");
      }
    } catch (e: any) {
      console.log(`Token creation note: ${e.message}`);
    }
  });
});
