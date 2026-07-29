import { describe, test } from "vitest";
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { Utils } from "../src/net/bigtangle/core/Utils";
import { Address } from "../src/net/bigtangle/core/Address";
import { TestParams } from "../src/net/bigtangle/params/TestParams";
import { ScriptBuilder } from "../src/net/bigtangle/script/ScriptBuilder";
import { Sha256Hash } from "../src/net/bigtangle/core/Sha256Hash";

/**
 * Test to expose cross-platform PQ key derivation differences.
 *
 * For a given 64-byte seed material, prints all derived values so they
 * can be compared with what Java BouncyCastle produces from the same seed.
 *
 * Java reference (layer0-mcmc PQKey):  getPubKey() = 0x05 || keyBundle.serialize()
 * TypeScript (@noble/post-quantum):    getPubKey() = keyBundle.serialize()
 */
describe("PQKeyCrossPlatformDiff", () => {
  test("export key material for cross-platform comparison", () => {
    // === Test vector 1: deterministic seed (like createKeyFromHex) ===
    const testPrivHex = "ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f";
    const seedBytes = new Uint8Array(Utils.HEX.decode(testPrivHex));
    const padded = new Uint8Array(64);
    padded.set(seedBytes, 0);
    const key1 = PQKey.fromKeyMaterial(padded);

    console.log("\n=== Test vector 1: seed from testPriv (32-byte hex, zero-padded to 64) ===");
    console.log("seedHex:", testPrivHex);
    console.log("--- TypeScript getPubKey() [raw keyBundle, no prefix] ---");
    console.log("getPubKey().length:", key1.getPubKey().length);
    console.log("getPubKey().slice(0,3) hex:", Utils.HEX.encode(key1.getPubKey().slice(0, 3)));
    console.log("getPublicKeyAsHex():", Utils.HEX.encode(key1.getPubKey()));
    console.log("");
    console.log("--- TypeScript getPrefixedPublicKeyBytes() [0x05 prefix] ---");
    console.log("getPrefixedPublicKeyBytes().length:", key1.getPrefixedPublicKeyBytes().length);
    console.log("getPrefixedPublicKeyBytes() hex:", Utils.HEX.encode(key1.getPrefixedPublicKeyBytes()));
    console.log("");
    console.log("--- Hashes ---");
    console.log("getPubKeyHash() [sha256hash160(getPubKey())]:", Utils.HEX.encode(key1.getPubKeyHash()));
    console.log("sha256hash160(prefixed):", Utils.HEX.encode(Utils.sha256hash160(key1.getPrefixedPublicKeyBytes())));
    console.log("");
    console.log("--- Addresses ---");
    const addr1 = Address.fromKey(TestParams.get(), key1);
    console.log("Address.fromKey(PQKey) Base58:", addr1.toString());
    console.log("key1.toAddressHex():", key1.toAddressHex());
    console.log("");

    // === Test vector 2: fromSeeds with fixed seeds ===
    const mlSeed = new Uint8Array(32).fill(0x01);
    const slhSeed = new Uint8Array(32).fill(0x02);
    const key2 = PQKey.fromSeeds(mlSeed, slhSeed);

    console.log("=== Test vector 2: fromSeeds(mlSeed=0x01*32, slhSeed=0x02*32) ===");
    console.log("getPubKey().length:", key2.getPubKey().length);
    console.log("getPublicKeyAsHex():", Utils.HEX.encode(key2.getPubKey()));
    console.log("getPrefixedPublicKeyBytes() hex:", Utils.HEX.encode(key2.getPrefixedPublicKeyBytes()));
    console.log("getPubKeyHash():", Utils.HEX.encode(key2.getPubKeyHash()));
    console.log("sha256hash160(prefixed):", Utils.HEX.encode(Utils.sha256hash160(key2.getPrefixedPublicKeyBytes())));
    const addr2 = Address.fromKey(TestParams.get(), key2);
    console.log("Address.fromKey Base58:", addr2.toString());
    console.log("toAddressHex():", key2.toAddressHex());
    console.log("");

    // === Show that scriptSig uses non-prefixed pubkey ===
    console.log("=== ScriptBuilder.createInputScript uses getPubKey() (raw, no 0x05) ===");
    const sig = key2.sign(Sha256Hash.ZERO_HASH);
    const inputScript = ScriptBuilder.createInputScript(sig, key2);
    const chunks = (inputScript as any).getChunks();
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.data) {
      console.log("scriptSig pubkey chunk length:", lastChunk.data.length);
      console.log("scriptSig pubkey chunk first byte (hex):", Utils.HEX.encode(lastChunk.data.slice(0, 1)));
      console.log("Expected 0x05 if prefixed, got:", lastChunk.data[0].toString(16));
    }
    console.log("");

    // === Show that createOutputScript(PQKey) creates P2PK instead of P2PKH ===
    console.log("=== ScriptBuilder.createOutputScript(PQKey) ===");
    const outScript = ScriptBuilder.createOutputScript(key2);
    console.log("Script ops:", outScript.getChunks().map((c: any) => c.opcode?.toString(16) || "data(" + c.data?.length + ")").join(" "));
    console.log("Java equivalent should be: OP_DUP(76) OP_HASH160(a9) data(20) OP_EQUALVERIFY(88) OP_CHECKSIG(ac)");
    console.log("");

    // === Summary ===
    console.log("=== ROOT CAUSE SUMMARY ===");
    console.log("1. Java PQKey.getPubKey()      = 0x05 || keyBundle.serialize()  [2665 bytes, starts with 0x05]");
    console.log("   TS  PQKey.getPubKey()       = keyBundle.serialize()         [2664 bytes, starts with 0x01]");
    console.log("2. Java getPubKeyHash()         = sha256hash160(0x05 || bundle) → different address");
    console.log("   TS  getPubKeyHash()          = sha256hash160(bundle)        → different address");
    console.log("3. ScriptBuilder.createOutputScript(PQKey):");
    console.log("   Java: P2PKH  (OP_DUP OP_HASH160 hash20 OP_EQUALVERIFY OP_CHECKSIG)");
    console.log("   TS:   P2PK   (pubkey OP_CHECKSIG)");
    console.log("4. ScriptBuilder.createInputScript(PQKey):");
    console.log("   Java: uses getPubKey()      → provides 0x05||bundle to scriptSig");
    console.log("   TS:   uses getPubKey()      → provides bundle (no prefix) to scriptSig");
  }, 120000);
});
