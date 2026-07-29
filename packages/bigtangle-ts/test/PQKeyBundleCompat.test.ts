import { describe, expect, test } from "vitest";
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { KeyBundle } from "../src/net/bigtangle/crypto/pq/KeyBundle";
import { Utils } from "../src/net/bigtangle/core/Utils";
import { Wallet } from "../src/net/bigtangle/wallet/Wallet";
import { TestParams } from "../src/net/bigtangle/params/TestParams";
import { Token } from "../src/net/bigtangle/core/Token";
import { TokenType } from "../src/net/bigtangle/core/TokenType";
import { MultiSignAddress } from "../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../src/net/bigtangle/core/MemoInfo";
import { Sha256Hash } from "../src/net/bigtangle/core/Sha256Hash";

const L0_URL = process.env.TEST_CONTEXT_ROOT || "http://localhost:8089/";

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

/**
 * Test to debug the "truncated key bytes" error in MultiSignServiceCreate.
 * Compares KeyBundle serialization format between TypeScript and Java
 * by tracing the exact bytes sent to the server during token creation.
 */
describe("PQKeyBundleCompat", () => {
  test("dump KeyBundle serialization format", () => {
    const key = PQKey.createNew();
    const bundle = key.getKeyBundle();
    const rawPub = key.getPubKey();
    const prefixedPub = key.getPrefixedPublicKeyBytes();

    console.log("=== Key creation ===");
    console.log("Private key hex:", key.getPrivateKeyHex().substring(0, 50) + "...");
    console.log("");

    console.log("=== getPubKey() (raw keyBundle, no prefix) ===");
    console.log("  length:", rawPub.length);
    console.log("  first 4 bytes hex:", Utils.HEX.encode(rawPub.slice(0, 4)));
    console.log("  hex:", Utils.HEX.encode(rawPub));
    console.log("");

    console.log("=== getPrefixedPublicKeyBytes() (0x05 prefix) ===");
    console.log("  length:", prefixedPub.length);
    console.log("  first 4 bytes hex:", Utils.HEX.encode(prefixedPub.slice(0, 4)));
    console.log("  hex:", Utils.HEX.encode(prefixedPub));
    console.log("");

    console.log("=== KeyBundle entries ===");
    const entries = (bundle as any).entries || [];
    for (const entry of entries) {
      console.log(`  algorithm: ${entry.algorithm}, pubKey length: ${entry.publicKey?.length || entry.pubKey?.length}`);
    }
    console.log("");

    // Create MultiSignAddress with prefixed hex (as sent to Java server)
    const multiSignAddr = new MultiSignAddress("testtokenid", "", Utils.HEX.encode(prefixedPub));
    console.log("=== MultiSignAddress ===");
    console.log("  tokenid:", multiSignAddr.getTokenid());
    console.log("  pubKeyHex:", multiSignAddr.getPubKeyHex()?.substring(0, 50) + "...");
    console.log("  pubKeyHex first byte:", multiSignAddr.getPubKeyHex()?.substring(0, 2));
    console.log("");

    // Check: Java PQKey.fromPublicOnly(byte[]) expects 0x05 prefix
    // The MultiSignAddress stores the hex from createToken.
    // Our test now uses getPrefixedPublicKeyBytes() which starts with 05.
    // Java's PQKey.fromPublicOnly calls extractKeyBundle:
    //   if prefixedPubkey[0] != 0x05 → throw "Invalid PQ public key prefix"
    //   then KeyBundle.deserialize(bytes[1:])
    const hexFirstByte = prefixedPub[0].toString(16).padStart(2, "0");
    console.log("=== Compatibility check ===");
    console.log(`  Prefixed pubkey first byte: 0x${hexFirstByte} (Java expects 0x05)`);
    expect(hexFirstByte).toBe("05");
    console.log("  ✅ Prefixed byte is correct (0x05)");
    console.log("");

    // The "truncated key bytes" error happens AFTER prefix check,
    // inside KeyBundle.deserialize. This means the bundle bytes after
    // stripping 0x05 are not valid for Java's KeyBundle.
    console.log("=== KeyBundle.serialize() bytes (after 0x05 prefix) ===");
    console.log("  length after 0x05:", prefixedPub.length - 1);
    console.log("  hex:", Utils.HEX.encode(prefixedPub.slice(1)));
    console.log("");
    console.log("  Java KeyBundle.deserialize will parse these bytes.");
    console.log("  If Java's KeyBundle format differs from TS's,");
    console.log("  it will throw 'truncated key bytes'.");
  });

  test("createToken and capture full multiSign server error", { timeout: 120000 }, async () => {
    const key = PQKey.createNew();
    const genesisKey = PQKey.createNew();
    const wallet = Wallet.fromKeysURL(TestParams.get(), [genesisKey, key], L0_URL);
    wallet.setFee(false);

    // Fund both keys
    await fundKey(key);
    await fundKey(genesisKey);
    await new Promise(r => setTimeout(r, 10000));

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
      await new Promise(r => setTimeout(r, 5000));
      const tokenResp = await httpPost("getTokenById", { tokenid });
      console.log("getTokenById response:", JSON.stringify(tokenResp).substring(0, 200));
    }
  });
});
