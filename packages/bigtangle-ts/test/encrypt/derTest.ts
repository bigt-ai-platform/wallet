import { ECDSASignature } from '../../src/net/bigtangle/core/ECDSASignature';
import { TransactionSignature } from '../../src/net/bigtangle/crypto/TransactionSignature';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { describe, it } from 'vitest';

describe('Debug DER Signature', () => {
  it('should debug DER signature parsing', async () => {
  // Test with the exact signature from the failing test
  const scriptSigHex = '483045022100cbd270d9b652ad48577ccd7d924b42063c913ef1135602b37f86c89e821cd3fa02206eb1a10d1898615121e843cdac7b43dd32248f0ebaaeccaa67199b55a554631b01';
  const scriptPubKeyHex = '2102721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975ac';
  
  console.log("=== Testing Signature Parsing ===");
  console.log("ScriptSig hex:", scriptSigHex);
  console.log("ScriptPubKey hex:", scriptPubKeyHex);
  
  // Parse the scriptSig to get the signature bytes
  const scriptSigBytes = Utils.HEX.decode(scriptSigHex);
  console.log("ScriptSig bytes length:", scriptSigBytes.length);
  
  // The first byte is the PUSHDATA opcode (0x48 = 72 bytes)
  const sigBytes = scriptSigBytes.slice(1); // Skip the PUSHDATA opcode
  console.log("Signature bytes length:", sigBytes.length);
  console.log("Signature bytes (hex):", Utils.HEX.encode(sigBytes));
  
  // Parse the scriptPubKey to get the public key
  const scriptPubKeyBytes = Utils.HEX.decode(scriptPubKeyHex);
  console.log("ScriptPubKey bytes length:", scriptPubKeyBytes.length);
  
  // The first byte is the PUSHDATA opcode (0x21 = 33 bytes), then the public key
  const pubKeyBytes = scriptPubKeyBytes.slice(1, 34); // Get the 33-byte public key
  console.log("Public key bytes length:", pubKeyBytes.length);
  console.log("Public key bytes (hex):", Utils.HEX.encode(pubKeyBytes));
  
  // Try to parse the signature using TransactionSignature.decodeFromBitcoin
  console.log("\n=== Testing TransactionSignature.decodeFromBitcoin ===");
  try {
    const sig = TransactionSignature.decodeFromBitcoin(sigBytes, true, true);
    console.log("✅ Signature parsed successfully with TransactionSignature.decodeFromBitcoin");
    console.log("r:", sig.r.toString(16));
    console.log("s:", sig.s.toString(16));
    console.log("sighashFlags:", sig.sighashFlags);
  } catch (e) {
    console.error("❌ Failed to parse signature with TransactionSignature.decodeFromBitcoin:", e);
  }
  
  // Try to parse just the DER part (without sighash byte)
  console.log("\n=== Testing ECDSASignature.decodeFromDER ===");
  const derBytes = sigBytes.slice(0, sigBytes.length - 1); // Remove sighash byte
  console.log("DER bytes length:", derBytes.length);
  console.log("DER bytes (hex):", Utils.HEX.encode(derBytes));
  
  try {
    const sig = ECDSASignature.decodeFromDER(derBytes);
    console.log("✅ DER signature parsed successfully with ECDSASignature.decodeFromDER");
    console.log("r:", sig.r.toString(16));
    console.log("s:", sig.s.toString(16));
  } catch (e) {
    console.error("❌ Failed to parse DER signature with ECDSASignature.decodeFromDER:", e);
  }
  
  // Test encoding and decoding round trip
  console.log("\n=== Testing Round Trip Encoding/Decoding ===");
  try {
    const sig = ECDSASignature.decodeFromDER(derBytes);
    const reencoded = sig.encodeToDER();
    console.log("Original DER length:", derBytes.length);
    console.log("Re-encoded DER length:", reencoded.length);
    console.log("DER matches:", Utils.HEX.encode(derBytes) === Utils.HEX.encode(reencoded));
    
    const decodedAgain = ECDSASignature.decodeFromDER(reencoded);
    console.log("Round trip successful:", sig.r === decodedAgain.r && sig.s === decodedAgain.s);
  } catch (e) {
    console.error("❌ Round trip test failed:", e);
  }
  });
});
