import { beforeAll, describe, expect, test } from "vitest";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Token } from "../../src/net/bigtangle/core/Token";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { Address } from "../../src/net/bigtangle/core/Address";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:18088/";

async function httpPost(path: string, body: any): Promise<any> {
  const res = await fetch(L0_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Fund a key using fundAddresses with prefixed pubkey (same as e2e pattern). */
async function fundKey(k: PQKey): Promise<void> {
  const fundRes = await httpPost("fundAddresses", {
    addresses: [{
      address: k.toAddressHex(),
      value: 10000000000,
      pubkey: Utils.HEX.encode(k.getPrefixedPublicKeyBytes()),
    }],
  });
  expect(fundRes.errorcode).toBe(0);
}

/** Poll for a token by ID until it appears or max retries. */
async function pollToken(tokenid: string, maxRetries = 40, delayMs = 2000): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    const resp = await httpPost("getTokenById", { tokenid });
    if (resp.tokens && resp.tokens.length > 0) return resp.tokens[0];
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Wait until the wallet has a spendable BIG UTXO (used after fundKey in
 * beforeAll). Replaces a fixed sleep so tests start as soon as the funded
 * coin is queryable.
 */
async function waitForSpendableBig(
  wallet: Wallet,
  maxRetries = 30,
  delayMs = 1000
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const candidates = await wallet.calculateAllSpendCandidates(null, false);
    const ok = candidates.some(
      (co) => co.getUTXO().getTokenId() === NetworkParameters.BIGTANGLE_TOKENID_STRING &&
        co.getValue().signum() > 0
    );
    if (ok) return;
    if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Genesis wallet has no spendable BIG UTXO after fundKey");
}

/**
 * Wait until the token's minted UTXOs are CONFIRMED (spendable), matching Java's
 * RemoteTokenTests.waitForTokenUtxos. Confirmation also confirms the token
 * creation's fee change, so the next token-creating test has a fresh confirmed
 * BIG fee source instead of the same spent one.
 */
async function waitForTokenUtxos(
  wallet: Wallet,
  tokenid: string,
  maxRetries = 60,
  delayMs = 3000
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const candidates = await wallet.calculateAllSpendCandidates(null, false);
    const ok = candidates.some(
      (co) => co.getUTXO().getTokenId() === tokenid && co.getValue().signum() > 0
    );
    if (ok) return;
    if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`Token ${tokenid.slice(0, 14)} UTXOs not confirmed after polling`);
}

/**
 * Create a token, matching Java's createToken helper.
 * tokenid is the prefixed public key hex.
 */
async function createToken(
  wallet: Wallet,
  key: PQKey,
  tokenname: string,
  decimals: number,
  domainname: string,
  description: string,
  amount: bigint,
  increment: boolean,
  tokenKeyValues: any,
  tokentype: TokenType,
  tokenid: string,
): Promise<any> {
  wallet.importKey(key);
  const token = new Token(tokenid, tokenname);
  token.setDescription(description);
  token.setDecimals(decimals);
  token.setAmount(amount);
  token.setTokenstop(!increment);
  token.setTokentype(tokentype);
  if (tokenKeyValues) token.setTokenKeyValues(tokenKeyValues);
  const addr = new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()), 0);
  return await wallet.createToken(
    key, domainname, increment, token, [addr], key.getPubKey(), new MemoInfo("coinbase"),
  );
}

describe("RemoteTokenIT", () => {
  let wallet: Wallet;
  let genesisKey: PQKey;

  beforeAll(async () => {
    // Matches Java RemoteTokenTests: ML-DSA-87 only with a 0x01 seed so the
    // wallet key is the root domain signer (TestParams.genesisPub).
    const mlDsaSeed = new Uint8Array(32).fill(0x01);
    genesisKey = PQKey.fromMLDSA(mlDsaSeed);
    wallet = Wallet.fromKeys(TestParams.get(), [genesisKey]);
    wallet.setServerURL(L0_URL);
    wallet.setFee(false);
    await fundKey(genesisKey);
    // Wait for the funded BIG UTXO to become spendable instead of a fixed 10s.
    await waitForSpendableBig(wallet);
  }, 30000);

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
    const big = await httpPost("getTokenById", { tokenid: "bc" });
    expect(big.tokens).toBeDefined();
    expect(big.tokens.length).toBeGreaterThan(0);
    expect(big.tokens[0].tokenname).toBe("BIG");
  });

  test("create token via signToken (TokenType.identity)", { timeout: 120000 }, async () => {
    const k = PQKey.createNew();
    const tokenid = Utils.HEX.encode(k.getPrefixedPublicKeyBytes());
    await fundKey(k);

    const block = await createToken(wallet, k, "testtoken", 0, "", "test",
      BigInt(1000000), true, null, TokenType.identity, tokenid);
    expect(block).toBeDefined();
    console.log("createToken returned block");

    const walletKeys = await wallet.walletKeys(null);
    const signed = await wallet.multiSign(tokenid, walletKeys[0], null);
    if (signed != null) {
      console.log("multiSign succeeded");
    }

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    expect(foundToken.tokenname).toBe("testtoken");
    console.log(`Token created and verified: ${foundToken.tokenname} (${tokenid})`);
  });

  test("beacon chain exists", async () => {
    const resp = await httpPost("getAllConfirmedReward", {});
    expect(resp).toBeDefined();
  });

  test("create token via wallet (TokenType.token)", { timeout: 120000 }, async () => {
    const k = PQKey.createNew();
    const tokenid = Utils.HEX.encode(k.getPrefixedPublicKeyBytes());
    await fundKey(k);

    const block = await createToken(wallet, k, "wallettoken", 0, "", "wallet test",
      BigInt(500000), true, null, TokenType.token, tokenid);
    expect(block).toBeDefined();

    const walletKeys = await wallet.walletKeys(null);
    const signed = await wallet.multiSign(tokenid, walletKeys[0], null);
    if (signed != null) {
      console.log("multiSign succeeded");
    }

    const foundToken = await pollToken(tokenid);
    expect(foundToken).not.toBeNull();
    expect(foundToken.tokenname).toBe("wallettoken");
    console.log(`Wallet token verified: ${foundToken.tokenname} (${tokenid})`);
  });

  test("create token and pay", { timeout: 300000 }, async () => {
    const issuer = PQKey.createNew();
    const tokenName = "paytoken";
    const tokenid = Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    const supply = BigInt(10000000);

    await fundKey(issuer);

    const block = await createToken(wallet, issuer, tokenName, 0, "", "token for payment test",
      supply, true, null, TokenType.token, tokenid);
    expect(block).toBeDefined();

    const walletKeys = await wallet.walletKeys(null);
    const signed = await wallet.multiSign(tokenid, walletKeys[0], null);
    if (signed != null) {
      console.log("multiSign succeeded");
    }

    const foundToken = await pollToken(tokenid, 40, 3000);
    expect(foundToken).not.toBeNull();
    console.log(`Token ${tokenName} created, id=${tokenid}`);

    // Wait for the token's minted UTXOs to be confirmed/spendable (matches
    // Java RemoteTokenTests.waitForTokenUtxos, which polls instead of a fixed sleep)
    console.log("Waiting for token minting confirmation...");
    await waitForTokenUtxos(wallet, tokenid);

    const payWallet = Wallet.fromKeysURL(TestParams.get(), [issuer], L0_URL);
    payWallet.setFee(false);

    const allCandidates = await payWallet.calculateAllSpendCandidates(null, false);
    const tokenUtxos = allCandidates.filter(u => u.getUTXO().getTokenId() === tokenid);
    console.log(`Issuer has ${tokenUtxos.length} token UTXOs (supply=${supply})`);

    if (tokenUtxos.length === 0) {
      // Fallback: log balance response for debugging
      const issuerHash = Utils.HEX.encode(issuer.getPubKeyHash());
      const balResp = await httpPost("getBalances", [issuerHash]);
      console.log("Balance response:", JSON.stringify(balResp).substring(0, 300));
    }

    expect(tokenUtxos.length).toBeGreaterThan(0);

    // Create a payment: send 1000 tokens to a recipient (matching Java's testCreateAndPayToken)
    const recipient = PQKey.createNew();
    const sendAmount = BigInt(1000);
    const tokenidBytes = Utils.HEX.decode(tokenid);
    const recipientAddr = Address.fromP2PKH(TestParams.get(), recipient.getPubKeyHash());

    const giveMoney = new Map<string, bigint>();
    giveMoney.set(recipientAddr.toString(), sendAmount);

    const tx = await payWallet.payToList(null, giveMoney, tokenidBytes, "pay");
    expect(tx).not.toBeNull();
    console.log(`Paid ${sendAmount} ${tokenName} tokens to recipient`);

    // Wait for MCMC to confirm the payment transaction
    const recipientWallet = Wallet.fromKeysURL(TestParams.get(), [recipient], L0_URL);
    recipientWallet.setFee(false);
    let recipientTokens: any[] = [];
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const after = await recipientWallet.calculateAllSpendCandidates(null, false);
      recipientTokens = after.filter(u => u.getUTXO().getTokenId() === tokenid);
      if (recipientTokens.length > 0) break;
    }
    console.log(`Recipient has ${recipientTokens.length} token UTXOs after payment`);
    expect(recipientTokens.length).toBeGreaterThan(0);
    console.log(`Pay token test completed`);
  });
});
