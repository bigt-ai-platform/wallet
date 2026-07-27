import { beforeEach, describe, expect, test } from "vitest";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Token } from "../../src/net/bigtangle/core/Token";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:18088/";

async function httpPost(path: string, body: any): Promise<any> {
  const res = await fetch(L0_URL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/*
 * Reproduces the same issue as e2e/playwright/tests/tokens.spec.ts:
 * wallet.createToken → saveToken → adjustSolveAndSign → signToken
 *
 * signToken returns errorcode: 0 but the block is saved to the
 * multisign table (pending), NOT to the blocks table.
 * The token never appears in searchTokens.
 *
 * Root cause: ServiceBaseCheck.checkFullTokenSolidity requires a
 * domain permission signature for first-time token issuances.
 * Without the genesis domain key signing, the check returns FAIL
 * and signTokenAndSaveBlock stores the block as pending multisign.
 */
describe("RemoteTokenIT", () => {
  let wallet: Wallet;
  let key: PQKey;

  beforeEach(() => {
    key = PQKey.createNew();
    wallet = Wallet.fromKeys(TestParams.get(), [key]);
    wallet.setServerURL(L0_URL);
    wallet.setFee(false);
  });

  test("token creation reproduces e2e signToken problem", { timeout: 60000 }, async () => {
    const tokename = "TestToken_" + Date.now().toString(36);
    const tokenid = Utils.HEX.encode(key.getPrefixedPublicKeyBytes());

    // Fund the key with BIG (required by SDK even with setFee(false))
    const fundRes = await httpPost("fundAddresses", {
      addresses: [{
        address: key.toAddressHex(), value: 10000000000,
        pubkey: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      }],
    });
    expect(fundRes.errorcode).toBe(0);
    console.log("Funded:", key.toAddressHex());

    // Create token matching Java RemoteTokenTests pattern
    const token = new Token(tokenid, tokename);
    token.setDescription("test");
    token.setDecimals(2);
    token.setAmount(BigInt(1000000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(1);
    token.setDomainName("");
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setConfirmed(true);
    token.setTokentype(TokenType.token);

    const addresses: MultiSignAddress[] = [
      new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()), 0),
    ];

    // Step 1: Create token via wallet.createToken
    // Internally calls: saveToken → adjustSolveAndSign → OkHttp3Util.post(signToken)
    const block = await wallet.createToken(
      key, "", true, token, addresses, key.getPubKey(),
      new MemoInfo("coinbase"),
    );
    expect(block).toBeDefined();
    console.log("signToken returned success, block:", block.getHashAsString());

    // Step 2: Check if token is confirmed
    await new Promise(r => setTimeout(r, 2000));

    const searchRes = await httpPost("searchTokens", {});
    const found = (searchRes.tokens || []).find((t: any) => t.tokenid === tokenid);
    if (found) {
      console.log("TOKEN CONFIRMED in searchTokens");
    } else {
      console.log("TOKEN NOT FOUND — block is pending in multisign table");
      console.log("PROBLEM: signToken saves to multisign, NOT to blocks");
      console.log("ROOT CAUSE: domain permission check requires genesis key signature");
    }
  });
});
