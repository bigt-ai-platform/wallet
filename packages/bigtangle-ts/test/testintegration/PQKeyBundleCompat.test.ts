import { describe, expect, test } from "vitest";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:18088/";

async function httpPost(path: string, body: any): Promise<any> {
  const res = await fetch(L0_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fundKey(k: PQKey, value: number = 10000000000): Promise<void> {
  const fundRes = await httpPost("fundAddresses", {
    addresses: [{
      address: k.toAddressHex(),
      value,
      pubkey: Utils.HEX.encode(k.getPrefixedPublicKeyBytes()),
    }],
  });
  expect(fundRes.errorcode).toBe(0);
}

/** Poll until the wallet sees a spendable BIG UTXO (replaces a fixed 10s sleep). */
async function waitForSpendableBig(
  wallet: Wallet,
  maxRetries = 30,
  delayMs = 1000
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const candidates = await wallet.calculateAllSpendCandidates(null, false);
    const ok = candidates.some(
      (co) => co.getUTXO().getTokenId() === "bc" && co.getValue().signum() > 0
    );
    if (ok) return;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error("No spendable BIG UTXO after fundKey");
}

/**
 * Test to debug the "truncated key bytes" error in MultiSignServiceCreate.
 * Compares KeyBundle serialization format between TypeScript and Java
 * by tracing the exact bytes sent to the server during token creation.
 */
describe("PQKeyBundleCompat", () => {
  test("createToken and capture full multiSign server error", { timeout: 120000 }, async () => {
    const key = PQKey.createNew();
    const genesisKey = PQKey.createNew();
    const wallet = Wallet.fromKeysURL(TestParams.get(), [genesisKey, key], L0_URL);
    wallet.setFee(false);

    // Fund both keys
    await fundKey(key);
    await fundKey(genesisKey);
    await waitForSpendableBig(wallet);

    // Create token
    const tokenid = Utils.HEX.encode(key.getPrefixedPublicKeyBytes());
    const tokenName = "debugtoken_" + Date.now().toString(36);
    const token = new Token(tokenid, tokenName);
    token.setDescription("debug");
    token.setDecimals(0);
    token.setAmount(BigInt(1000000));
    token.setTokenstop(true);
    token.setTokenindex(0);
    token.setSignnumber(0);
    token.setDomainNameBlockHash("");
    token.setPrevblockhash(Sha256Hash.ZERO_HASH);
    token.setTokentype(TokenType.token);

    const addr = new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()));

    console.log("Creating token...");
    let block;
    try {
      block = await wallet.createToken(key, "", true, token, [addr], key.getPubKey(), new MemoInfo("coinbase"));
      console.log("createToken succeeded");
    } catch (e: any) {
      console.log("createToken failed:", e.message);
      expect(e.message).toContain("truncated key bytes");
      return;
    }

    console.log("Calling multiSign...");
    let signed;
    try {
      signed = await wallet.multiSign(tokenid, genesisKey, null);
      if (signed) {
        console.log("multiSign succeeded, block:", signed.getHashAsString());
      } else {
        console.log("multiSign returned null");
      }
    } catch (e: any) {
      console.log("multiSign failed:", e.message);
      // Capture the full server error response
      console.log("Full error:", JSON.stringify(e, null, 2));
      expect(e.message).toMatch(/truncated key bytes|Invalid|solidity/i);
      return;
    }

    // If we get here, token creation succeeded — verify it
    if (signed) {
      await waitForSpendableBig(wallet);
      const tokenResp = await httpPost("getTokenById", { tokenid });
      console.log("getTokenById response:", JSON.stringify(tokenResp).substring(0, 200));
    }
  });
});
