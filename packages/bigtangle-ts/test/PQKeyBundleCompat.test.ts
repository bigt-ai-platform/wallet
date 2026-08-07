import { describe, expect, test } from "vitest";
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { Utils } from "../src/net/bigtangle/core/Utils";
import { MultiSignAddress } from "../src/net/bigtangle/core/MultiSignAddress";

/**
 * Test to debug the "truncated key bytes" error in MultiSignServiceCreate.
 * Compares KeyBundle serialization format between TypeScript and Java
 * by tracing the exact bytes sent to the server during token creation.
 *
 * The server-dependent part lives in test/testintegration/PQKeyBundleCompat.test.ts.
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
});
