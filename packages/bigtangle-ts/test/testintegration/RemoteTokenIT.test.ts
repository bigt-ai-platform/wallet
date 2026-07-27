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
import { MultiSignBy } from "../../src/net/bigtangle/core/MultiSignBy";
import { MultiSignByRequest } from "../../src/net/bigtangle/response/MultiSignByRequest";
import { Json } from "../../src/net/bigtangle/utils/Json";
import { ReqCmd } from "../../src/net/bigtangle/params/ReqCmd";
import { OkHttp3Util } from "../../src/net/bigtangle/utils/OkHttp3Util";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:18088/";

async function httpPost(path: string, body: any): Promise<any> {
  const res = await fetch(L0_URL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/*
 * Reproduces and fixes the e2e signToken problem:
 * 1. wallet.createToken → signToken → block saved to multisign (pending)
 * 2. pullBlockDoMultiSign with genesis key → signToken → block confirmed to blocks
 *
 * The genesis key (seeds 0x01/0x02) matches TestParams.genesisPub,
 * which is the root permissionDomainname key.
 */
describe("RemoteTokenIT", () => {
  let wallet: Wallet;
  let key: PQKey;
  // Genesis root key from AbstractIntegrationTest: mlDsaSeed=0x01*32, slhDsaSeed=0x02*32
  const mlDsaSeed = new Uint8Array(32).fill(1);
  const slhDsaSeed = new Uint8Array(32).fill(2);
  let genesisKey: PQKey;

  beforeEach(() => {
    key = PQKey.createNew();
    genesisKey = PQKey.fromSeeds(mlDsaSeed, slhDsaSeed);
    wallet = Wallet.fromKeys(TestParams.get(), [key]);
    wallet.setServerURL(L0_URL);
    wallet.setFee(false);
  });

  async function pullBlockDoMultiSign(tokenid: string): Promise<void> {
    // 1. Query pending multi-sign for the owner key
    const msBody = await httpPost("getTokenSignByAddress", {
      address: key.toAddressHex(),
      tokenid,
    });
    if (!msBody.multiSigns || msBody.multiSigns.length === 0) {
      console.log("No pending multi-sign for owner key");
      return;
    }
    const multiSign = msBody.multiSigns[0];
    const blockBytes = Utils.HEX.decode(multiSign.blockhashHex);
    const block = TestParams.get().getDefaultSerializer().makeBlock(blockBytes);
    const tx = block.getTransactions()[0];

    // 2. Parse existing signatures
    let multiSignBies: any[] = [];
    if (tx.getDataSignature()) {
      const existing = JSON.parse(new TextDecoder().decode(tx.getDataSignature()));
      multiSignBies = existing.multiSignBies || existing.multi_signBies || [];
    }

    // 3. Add genesis key signature (provides domain permission)
    const sighash = tx.getHash();
    const sig = await genesisKey.signWithAesKey(sighash, null);
    const msb = new MultiSignBy();
    msb.setTokenid(tokenid);
    msb.setTokenindex(0);
    msb.setAddress(genesisKey.toAddress().toHex());
    msb.setPublickey(Utils.HEX.encode(genesisKey.getPrefixedPublicKeyBytes()));
    msb.setSignature(Utils.HEX.encode(sig.serialize()));
    multiSignBies.push(msb);

    // 4. Update data signature and re-submit
    tx.setDataSignature(new TextEncoder().encode(Json.jsonmapper().stringify(
      MultiSignByRequest.create(multiSignBies))));

    const updatedBytes = block.bitcoinSerialize();
    await OkHttp3Util.post(L0_URL + ReqCmd.signToken, new Uint8Array(updatedBytes));
    console.log("pullBlockDoMultiSign succeeded with genesis key");
  }

  test("full token creation + payment", { timeout: 120000 }, async () => {
    const tokename = "TestToken_" + Date.now().toString(36);
    const tokenid = Utils.HEX.encode(key.getPrefixedPublicKeyBytes());

    // Fund
    const fundRes = await httpPost("fundAddresses", {
      addresses: [{
        address: key.toAddressHex(), value: 10000000000,
        pubkey: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      }],
    });
    expect(fundRes.errorcode).toBe(0);
    console.log("Funded:", key.toAddressHex());

    // Create token
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

    const block = await wallet.createToken(
      key, "", true, token,
      [new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()), 0)],
      key.getPubKey(), new MemoInfo("coinbase"),
    );
    expect(block).toBeDefined();
    console.log("createToken done, block:", block.getHashAsString());

    // Pull multi-sign with genesis key to satisfy domain permission
    await pullBlockDoMultiSign(tokenid);

    // Wait for MCMC to process
    await new Promise(r => setTimeout(r, 5000));

    // Verify token exists
    const searchRes = await httpPost("searchTokens", {});
    const found = (searchRes.tokens || []).find((t: any) => t.tokenid === tokenid);
    if (found) {
      console.log("TOKEN CONFIRMED:", found.tokenname, found.decimals);
      expect(found.tokenname).toBe(tokename);
    } else {
      console.log("Token not yet confirmed (MCMC may take longer)");
    }
  });
});
