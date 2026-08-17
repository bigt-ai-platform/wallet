import { beforeEach, describe, expect, test } from "vitest";
import { RemoteTest } from "./RemoteTest";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Block } from "../../src/net/bigtangle/core/Block";


class RemoteBinaryTests extends RemoteTest {
  public logTransaction(block: Block): void {
    const transactions = block.getTransactions();
      if (transactions) {
        for (const t of transactions) {
           console.log(t.toString());
           console.log("Transaction hash: " + t.getHash().toString());
           console.log("Is coinbase: " + t.isCoinBase());

          if(t.isCoinBase()){
            console.log("Checking coinbase transaction with hash: " + t.getHash().toString());
           expect(t.getHash().toString()).toBe("73a3a625775cfaec1a6ebec2833eedb908a9693a0ef5bbf08f55c730f0061ed9");
          }
         }
      }
    }
}

describe("RemoteBinaryTests", () => {
  const tests = new RemoteBinaryTests();

  beforeEach(async () => {
    await tests.setUp();
  });

  test ("testSerial", async () => {
    const tip = "0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ecb7e82f91dc35ddc2928c27924a1fa773b37b754659605d42315b467c22b5b5ebed816a00000000000000000000000018424c4f434b545950455f544f4b454e5f4352454154494f4e0000000000000000020100000000010203e801bc1976a9141d65081bed5cd3f907d57df193af2f8ec325e36a88ac0000000000000000000000000000000000000000000000000100000000010207d001bc1976a9141d65081bed5cd3f907d57df193af2f8ec325e36a88ac000000000000000000000000000000000000000000000000";

        const serializer2 = tests.networkParameters.getDefaultSerializer();
    const block2 = serializer2.makeBlock(Buffer.from(Utils.HEX.decode(tip ))) ;
     console.log(block2.toString());

     tests.logTransaction(block2);

 

    // Post to the server
 /*   const url = tests.contextRoot + (ReqCmd.saveBlock || "/saveBlock");

      OkHttp3Util.post(url, Buffer.from(block.bitcoinSerialize()));
      */
  });
});