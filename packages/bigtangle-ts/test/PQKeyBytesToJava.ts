/**
 * Generates PQ key bytes from TypeScript and prints them in Java-compatible
 * formats, so they can be copy-pasted into a Java test to compare
 * KeyBundle.deserialize() behavior.
 *
 * Usage: npx tsx test/PQKeyBytesToJava.ts
 */
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { Utils } from "../src/net/bigtangle/core/Utils";

function toJavaByteArray(hex: string): string {
  const bytes = Utils.HEX.decode(hex);
  let sb = "new byte[]{";
  for (let i = 0; i < Math.min(bytes.length, 100); i++) {
    if (i > 0) sb += ",";
    sb += "(byte)0x" + bytes[i].toString(16).padStart(2, "0");
    if (i >= 99) { sb += ",..."; break; }
  }
  sb += "}";
  return sb;
}

const key = PQKey.createNew();
const rawPub = key.getPubKey();
const prefixedPub = key.getPrefixedPublicKeyBytes();
const privHex = key.getPrivateKeyHex();

console.log("============================================");
console.log("PQ Key Cross-Platform Compatibility Debug");
console.log("============================================");
console.log("");

console.log("=== TypeScript PQKey.fromKeyMaterial seed ===");
console.log("privateKeyHex:", privHex);
console.log("(Use PQKey.fromKeyMaterial(Utils.HEX.decode(privateKeyHex)) in TS)");
console.log("(Use PQKey.fromKeyMaterial(Utils.HEX.decode(privateKeyHex)) in Java)");
console.log("");

console.log("=== Public key bytes ===");
console.log("getPubKey() (raw keyBundle, no prefix):");
console.log("  hex:", Utils.HEX.encode(rawPub));
console.log("  length:", rawPub.length);
console.log("  first 4 bytes:", Utils.HEX.encode(rawPub.slice(0, 4)));
console.log("");

console.log("getPrefixedPublicKeyBytes() (with 0x05):");
console.log("  hex:", Utils.HEX.encode(prefixedPub));
console.log("  length:", prefixedPub.length);
console.log("  first 4 bytes:", Utils.HEX.encode(prefixedPub.slice(0, 4)));
console.log("");

console.log("=== KeyBundle.serialize() structure ===");
const bundle = key.getKeyBundle();
const raw = Utils.HEX.encode(rawPub);
console.log("  Full hex:", raw);
console.log("  Length:", rawPub.length);
console.log("");

// Parse TS bundle format
console.log("=== Interpreting TS KeyBundle.serialize() ===");
console.log("  Byte 0 (version):", rawPub[0]);
console.log("  Byte 1 (entry count):", rawPub[1]);
console.log("");

let offset = 2;
for (let e = 0; e < rawPub[1]; e++) {
  if (offset + 2 > rawPub.length) break;
  const alg = rawPub[offset];
  const keyLen = (rawPub[offset + 1] << 8) | rawPub[offset + 2];
  console.log(`  Entry ${e}:`);
  console.log(`    algorithm byte[${offset}]: ${alg} (${alg === 1 ? "ML-DSA-87" : alg === 2 ? "SLH-DSA-SHA2-256s" : "UNKNOWN"})`);
  console.log(`    key length bytes[${offset+1}-${offset+2}]: ${rawPub[offset+1].toString(16)} ${rawPub[offset+2].toString(16)} = ${keyLen}`);
  console.log(`    public key[${offset+3}..${offset+2+keyLen}] hex:`, Utils.HEX.encode(rawPub.slice(offset+3, offset+3+Math.min(keyLen, 32))));
  offset += 3 + keyLen;
}
console.log("");

console.log("=== Java KeyBundle.deserialize expected format ===");
console.log("  Need to check Java's KeyBundle serialization format.");
console.log("  If Java expects different byte layout, 'truncated key bytes'");
console.log("  is thrown when deserializing the bundle bytes.");
console.log("");

console.log("=== Java byte array literal (first 100 bytes of prefixed) ===");
console.log(toJavaByteArray(Utils.HEX.encode(prefixedPub)));
console.log("");

console.log("=== Copy this private key hex into Java test ===");
console.log("String privHex = \"" + privHex + "\";");
console.log("PQKey javaKey = PQKey.fromKeyMaterial(Utils.HEX.decode(privHex));");
console.log("byte[] javaPubKey = javaKey.getPubKey(); // Java version (prefixed)");
console.log("byte[] tsPubKey = Utils.HEX.decode(\"" + Utils.HEX.encode(rawPub) + "\"); // TS version (raw)");
console.log("");

console.log("=== Compare lengths ===");
console.log("TS rawPub length:", rawPub.length);
console.log("Java getPubKey() length:", "? (expected 2665 = TS raw + 1 for 0x05)");
console.log("");

console.log("=== Java fromPublicOnly(TS prefixed bytes) ===");
console.log("byte[] tsPrefixed = Utils.HEX.decode(\"" + Utils.HEX.encode(prefixedPub) + "\");");
console.log("try {");
console.log("  PQKey javaKey = PQKey.fromPublicOnly(tsPrefixed);");
console.log("  System.out.println(\"SUCCESS: \" + javaKey.toAddress().toBase58());");
console.log("} catch (Exception e) {");
console.log("  System.out.println(\"FAILED: \" + e.getMessage());");
console.log("  // If 'truncated key bytes', KeyBundle.deserialize format mismatch");
console.log("}");
