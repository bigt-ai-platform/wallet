import { describe, expect, test } from "vitest";
import { TestParams } from "../src/net/bigtangle/params/TestParams";
import { PQKey } from "../src/net/bigtangle/crypto/pq/PQKey";
import { Sha256Hash } from "../src/net/bigtangle/core/Sha256Hash";
import { Utils } from "../src/net/bigtangle/core/Utils";
import { Transaction } from "../src/net/bigtangle/core/Transaction";
import { TransactionInput } from "../src/net/bigtangle/core/TransactionInput";
import { TransactionOutput } from "../src/net/bigtangle/core/TransactionOutput";
import { Coin } from "../src/net/bigtangle/core/Coin";
import { Address } from "../src/net/bigtangle/core/Address";
import { SigHash } from "../src/net/bigtangle/core/SigHash";
import { ScriptBuilder } from "../src/net/bigtangle/script/ScriptBuilder";
import * as fs from "fs";

const params = TestParams.get();

/**
 * Unit tests for PQ transaction signing, serialization, and hashForSignature.
 *
 * Verifies the fix for TransactionInput.length calculation (same bug that
 * was fixed in Java at commit 9720d31c0 — length was computed before reading
 * scriptBytes, sequence, and connectedOutput, causing under-report by
 * 4 + connectedOutputSize bytes).
 */
describe("PQTransactionSign", () => {
  test("serialization round-trip preserves bytes", () => {
    const tx = new Transaction(params);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);
    const bytes = tx.bitcoinSerialize();
    const tx2 = params.getDefaultSerializer().makeTransaction(new Uint8Array(bytes));
    expect(new Uint8Array(tx2.bitcoinSerialize())).toEqual(new Uint8Array(bytes));
  });

  test("input length matches serialized size after parse", () => {
    // Build a tx with known input bytes
    const tx = new Transaction(params);
    tx.version = 2;
    const input = new TransactionInput(params, tx, new Uint8Array(0));
    tx.addInput(input);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);

    // Serialize and re-parse
    const bytes = tx.bitcoinSerialize();
    const tx2 = params.getDefaultSerializer().makeTransaction(new Uint8Array(bytes));

    // After parse, each input's length must equal the number of bytes consumed
    for (let i = 0; i < tx2.inputs.length; i++) {
      const inp = tx2.inputs[i];
      // Re-serialize the input alone and check its length
      const inpBytes = inp.bitcoinSerialize();
      expect(inp.length).toBe(inpBytes.length);
    }
  });

  test("input length correctly includes sequence + connectedOutput", () => {
    // Create a minimal tx with a real UTXO (connectedOutput)
    const key = PQKey.createNew();
    const tx = new Transaction(params);
    tx.version = 2;

    // Build a proper UTXO-like input
    const inp = new TransactionInput(params, tx, new Uint8Array(0));
    // Set a connectedOutput to simulate a real UTXO being spent
    const coin = Coin.valueOf(10000n, Utils.HEX.decode("bc"));
    const connectedOut = new TransactionOutput(params, tx, coin, new Uint8Array(20));
    inp.getOutpoint().connectedOutput = connectedOut;
    tx.addInput(inp);

    const out = new TransactionOutput(params, tx, Coin.valueOf(5000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);

    // Serialize and re-parse
    const bytes = tx.bitcoinSerialize();
    const tx2 = params.getDefaultSerializer().makeTransaction(new Uint8Array(bytes));

    for (let i = 0; i < tx2.inputs.length; i++) {
      const inp2 = tx2.inputs[i];
      const inpBytes = inp2.bitcoinSerialize();
      expect(inp2.length).toBe(inpBytes.length);
    }
  });

  test("hashForSignature is deterministic", () => {
    const tx = new Transaction(params);
    tx.version = 2;
    const input = new TransactionInput(params, tx, new Uint8Array(0));
    tx.addInput(input);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);

    const scriptPubKey = ScriptBuilder.createOutputScript(
      Address.fromKey(params, PQKey.createNew()),
    ).getProgram();
    const hash1 = tx.hashForSignature(0, scriptPubKey, SigHash.ALL, false);
    const hash2 = tx.hashForSignature(0, scriptPubKey, SigHash.ALL, false);
    expect(hash1.toString()).toBe(hash2.toString());
  });

  test("hashForSignature round-trips after parse", () => {
    // The hashForSignature must be the same before and after
    // serialization → deserialization round-trip
    const key = PQKey.createNew();
    const tx = new Transaction(params);
    tx.version = 2;
    const input = new TransactionInput(params, tx, new Uint8Array(0));
    tx.addInput(input);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);
    tx.memo = "test memo for hash stability";

    const scriptPubKey = ScriptBuilder.createOutputScript(
      Address.fromKey(params, key),
    ).getProgram();

    // Hash before serialization
    const hashBefore = tx.hashForSignature(0, scriptPubKey, SigHash.ALL, false);

    // Round-trip
    const bytes = tx.bitcoinSerialize();
    const tx2 = params.getDefaultSerializer().makeTransaction(new Uint8Array(bytes));

    // Hash after deserialization — must be identical
    const hashAfter = tx2.hashForSignature(0, scriptPubKey, SigHash.ALL, false);
    expect(hashAfter.toString()).toBe(hashBefore.toString());
  });

  test("sign and export vectors", () => {
    const key = PQKey.createNew();
    const tx = new Transaction(params);
    tx.version = 2;
    const input = new TransactionInput(params, tx, new Uint8Array(0));
    tx.addInput(input);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);

    const scriptPubKey = ScriptBuilder.createOutputScript(
      Address.fromKey(params, key),
    ).getProgram();
    const hash = tx.hashForSignature(0, scriptPubKey, SigHash.ALL, false);
    const sigBundle = key.sign(hash);

    const vectors = {
      txHex: Utils.HEX.encode(tx.bitcoinSerialize()),
      scriptPubKeyHex: Utils.HEX.encode(scriptPubKey),
      inputIndex: 0,
      sigHashType: 1,
      pubKeyHex: Utils.HEX.encode(key.getPrefixedPublicKeyBytes()),
      sigHex: Utils.HEX.encode(sigBundle.serialize()),
      hashHex: Utils.HEX.encode(hash.getBytes()),
    };
    fs.writeFileSync("/tmp/pq-tx-test-vectors.json", JSON.stringify(vectors, null, 2));
    console.log("Vectors written to /tmp/pq-tx-test-vectors.json");
  });
});
