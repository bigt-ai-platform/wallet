import { Buffer } from "buffer";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { UtilGeneseBlock } from "../../src/net/bigtangle/core/UtilGeneseBlock";
import { Utils } from "../../src/net/bigtangle/utils/Utils";
import { describe, test } from "vitest";

describe("Debug Genesis Block", () => {
  const PARAMS = TestParams.get();
  
  test("debug step by step", () => {
    // Step 1: Create the genesis block
    console.log("Step 1: Creating genesis block");
    const genesisBlock = UtilGeneseBlock.createGenesis(PARAMS);
    console.log("Genesis block created");
    
    // Step 2: Serialize it
    console.log("Step 2: Serializing genesis block");
    const blockBytes = Buffer.from(genesisBlock.unsafeBitcoinSerialize());
    console.log("Block serialized, length:", blockBytes.length);
    
    // Step 3: Check the hex
    console.log("Step 3: Converting to hex");
    const serializedHex = Utils.HEX.encode(blockBytes);
    console.log("Serialized hex length:", serializedHex.length);
    console.log("First 100 chars:", serializedHex.substring(0, 100));
    
    // Step 4: Parse it back
    console.log("Step 4: Parsing block back");
    const parsedBlock = PARAMS.getDefaultSerializer().makeBlock(blockBytes);
    console.log("Block parsed");
    
    // Step 5: Check properties
    console.log("Step 5: Checking properties");
    console.log("Version:", parsedBlock.getVersion());
    console.log("Time:", parsedBlock.getTimeSeconds());
    console.log("Height:", parsedBlock.getHeight());
    console.log("Prev block hash:", parsedBlock.getPrevBlockHash().toString());
    console.log("Merkle root:", parsedBlock.getMerkleRoot().toString());
    console.log("Difficulty target:", parsedBlock.getDifficultyTarget());
    console.log("Nonce:", parsedBlock.getNonce());
    console.log("Block type:", parsedBlock.getBlockType());
    
    // Step 6: Serialize again
    console.log("Step 6: Serializing parsed block");
    const parsedBlockBytes = Buffer.from(parsedBlock.bitcoinSerialize());
    const reparsedHex = Utils.HEX.encode(parsedBlockBytes);
    console.log("Reparsed hex length:", reparsedHex.length);
    console.log("First 100 chars:", reparsedHex.substring(0, 100));
    
    // Step 7: Compare
    console.log("Step 7: Comparing hex strings");
    console.log("Original === Reparsed:", serializedHex === reparsedHex);
  });
});