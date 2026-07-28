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

describe("PQTransactionSign", () => {
  test("serialization round-trip", () => {
    const tx = new Transaction(params);
    const out = new TransactionOutput(params, tx, Coin.valueOf(1000n, Utils.HEX.decode("bc")), new Uint8Array(20));
    tx.addOutput(out);
    const bytes = tx.bitcoinSerialize();
    const tx2 = params.getDefaultSerializer().makeTransaction(new Uint8Array(bytes));
    expect(new Uint8Array(tx2.bitcoinSerialize())).toEqual(new Uint8Array(bytes));
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
    console.log("Vectors written");
  });
});
