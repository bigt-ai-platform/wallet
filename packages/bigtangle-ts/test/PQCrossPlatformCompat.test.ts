import { describe, expect, test } from "vitest";
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { Sha256Hash } from "../src/net/bigtangle/core/Sha256Hash";
import { Utils } from "../src/net/bigtangle/core/Utils";
import { PQConstants } from "../src/net/bigtangle/crypto/pq/PQConstants";
import * as fs from "fs";

/**
 * Cross-platform PQ signature compatibility test.
 *
 * Verifies that @noble/post-quantum signatures match the FIPS 204/205
 * standard sizes expected by Java BouncyCastle, and exports test vectors
 * for cross-platform verification.
 *
 * Standard signature sizes (FIPS 204 §7.3 / FIPS 205 §10.2):
 *   ML-DSA-87:       4627 bytes
 *   SLH-DSA-SHA2-256s: 29792 bytes
 */
describe("PQCrossPlatformCompat", () => {
  test("signature sizes match FIPS 204/205 standards", () => {
    const mlSeed = new Uint8Array(32).fill(0x42);
    const slhSeed = new Uint8Array(32).fill(0x24);
    const key = PQKey.fromSeeds(mlSeed, slhSeed);

    const msg = Sha256Hash.hash(new TextEncoder().encode("cross-platform-pq-test"));
    const baseHash = Sha256Hash.twiceOf(msg);

    const sigBundle = key.sign(baseHash);

    const mlEntry = sigBundle.getEntry(PQConstants.ALG_ML_DSA_87);
    const slhEntry = sigBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
    expect(mlEntry).toBeDefined();
    expect(slhEntry).toBeDefined();

    // FIPS standard sizes
    expect(mlEntry!.signature.length).toBe(4627);
    expect(slhEntry!.signature.length).toBe(29792);

    // Bundle format: version(1) + count(1) + entry1(alg+len+data) + entry2(alg+len+data)
    const expectedBundleSize = 1 + 1 + (1 + 2 + 4627) + (1 + 2 + 29792);
    expect(sigBundle.serialize().length).toBe(expectedBundleSize);

    // Export test vectors for Java BC to verify
    const vectors = {
      pubKeyHex: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      sigHex: Utils.HEX.encode(sigBundle.serialize()),
      baseHashHex: Utils.HEX.encode(baseHash.getBytes()),
    };
    fs.writeFileSync("/tmp/pq-test-vectors.json", JSON.stringify(vectors, null, 2));
    console.log("Test vectors written to /tmp/pq-test-vectors.json");
  });
});


