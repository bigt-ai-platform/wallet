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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe("RemoteTokenIT", () => {
  let wallet: Wallet;
  let genesisKey: PQKey;
  let key: PQKey;

  beforeEach(() => {
    const mlDsaSeed = new Uint8Array(32).fill(0x01);
    const slhDsaSeed = new Uint8Array(32).fill(0x02);
    genesisKey = PQKey.fromSeeds(mlDsaSeed, slhDsaSeed);
    key = PQKey.createNew();
    wallet = Wallet.fromKeys(TestParams.get(), [genesisKey, key]);
    wallet.setServerURL(L0_URL);
    wallet.setFee(false);
  });

  async function getTokenById(tokenid: string): Promise<any> {
    const resp = await httpPost("getTokenById", { tokenid });
    if (resp.tokens && resp.tokens.length > 0) {
      return resp.tokens[0];
    }
    return null;
  }

  async function pollToken(tokenid: string, maxRetries = 15, delayMs = 2000): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
      const t = await getTokenById(tokenid);
      if (t) return t;
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  async function fundKey(k: PQKey): Promise<void> {
    const fundRes = await httpPost("fundAddresses", {
      addresses: [{
        address: k.toAddressHex(), value: 10000000000,
        pubkey: Utils.HEX.encode(k.getPrefixedPublicKeyBytes()),
      }],
    });
    expect(fundRes.errorcode).toBe(0);
  }

  test("server health check", async () => {
    const res = await fetch(L0_URL, { method: "POST" });
    const body = await res.text();
    expect(body).toMatch(/Bigtangle|duration/);
  });

  test("BIG token exists via searchTokens", async () => {
    const { tokenList } = await wallet.searchToken();
    expect(tokenList).toBeDefined();
    expect(tokenList.length).toBeGreaterThan(0);
    const big = tokenList.find((t: any) => t.tokenid === "bc" || t.tokenname === "BIG");
    expect(big).toBeDefined();
    expect(big.tokenname).toBe("BIG");
  });

  test("get BIG token by ID", async () => {
    const { tokenList } = await wallet.searchToken();
    expect(tokenList.length).toBeGreaterThan(0);
    const big = await getTokenById("bc");
    expect(big).not.toBeNull();
    expect(big.tokenname).toBe("BIG");
  });

  test("create token via signToken (TokenType.identity)", { timeout: 60000 }, async () => {
    const k = PQKey.createNew();
    const tokenid = Utils.HEX.encode(k.getPrefixedPublicKeyBytes());
    await fundKey(k);

    const tokenName = "testtoken_" + Date.now().toString(36);
    const token = new Token(tokenid, tokenName);
    token.setDescription("test");
    token.setDecimals(0);
    token.setAmount(BigInt(1000000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setTokentype(TokenType.identity);

    const addr = new MultiSignAddress(tokenid, "", Utils.HEX.encode(k.getPrefixedPublicKeyBytes()), 0);
    const block = await wallet.createToken(
      k, "", true, token, [addr], k.getPubKey(), new MemoInfo("coinbase"),
    );
    expect(block).toBeDefined();

    const signed = await wallet.multiSign(tokenid, genesisKey, null);
    expect(signed).not.toBeNull();

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    expect(foundToken.tokenname).toBe(tokenName);
  });

  test("beacon chain exists", async () => {
    const resp = await httpPost("getAllConfirmedReward", {});
    expect(resp).toBeDefined();
  });

  test("create token via wallet (TokenType.token)", { timeout: 60000 }, async () => {
    const k = PQKey.createNew();
    const tokenid = Utils.HEX.encode(k.getPrefixedPublicKeyBytes());
    await fundKey(k);

    const tokenName = "wallettoken_" + Date.now().toString(36);
    const token = new Token(tokenid, tokenName);
    token.setDescription("wallet test");
    token.setDecimals(0);
    token.setAmount(BigInt(500000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setTokentype(TokenType.token);

    const addr = new MultiSignAddress(tokenid, "", Utils.HEX.encode(k.getPrefixedPublicKeyBytes()), 0);
    const block = await wallet.createToken(
      k, "", true, token, [addr], k.getPubKey(), new MemoInfo("coinbase"),
    );
    expect(block).toBeDefined();

    const signed = await wallet.multiSign(tokenid, genesisKey, null);
    expect(signed).not.toBeNull();

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    expect(foundToken.tokenname).toBe(tokenName);
  });

  test("create token and verify minting (UTXOs available)", { timeout: 120000 }, async () => {
    const issuer = PQKey.createNew();
    const tokenid = Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());

    const payWallet = Wallet.fromKeys(TestParams.get(), [genesisKey, issuer]);
    payWallet.setServerURL(L0_URL);
    payWallet.setFee(false);

    await fundKey(issuer);

    const tokenName = "paytoken_" + Date.now().toString(36);
    const token = new Token(tokenid, tokenName);
    token.setDescription("paytoken");
    token.setDecimals(0);
    token.setAmount(BigInt(10000000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setTokentype(TokenType.token);

    const addr = new MultiSignAddress(tokenid, "", Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes()), 0);
    const block = await payWallet.createToken(
      issuer, "", true, token, [addr], issuer.getPubKey(), new MemoInfo("coinbase"),
    );
    expect(block).toBeDefined();

    const signed = await payWallet.multiSign(tokenid, genesisKey, null);
    expect(signed).not.toBeNull();

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    expect(foundToken.tokenname).toBe(tokenName);

    // Wait for blockbatch to mint the initial supply as spendable UTXOs
    await new Promise(r => setTimeout(r, 15000));

    // Verify the issuer has token UTXOs (supply was minted)
    const utxos = await payWallet.calculateAllSpendCandidates(null, false);
    const tokenUtxos = utxos.filter(u => {
      const utxoTokenId = u.getUTXO().getTokenId();
      return utxoTokenId === tokenid;
    });
    expect(tokenUtxos.length).toBeGreaterThan(0);
    console.log("Token minted with", tokenUtxos.length, "UTXOs, supply:", tokenUtxos[0].getValue().getValue().toString());
  });
});
