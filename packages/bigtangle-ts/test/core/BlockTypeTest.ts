import { describe, test, expect } from "vitest";
import { BlockType } from "../../src/net/bigtangle/core/BlockType";
 

describe("BlockTypeTest", () => {
  test("testBlockType", () => {
    // Check that BlockType enum values are correct
        expect(BlockType.BLOCKTYPE_INITIAL).toBe(0);
        expect(BlockType.BLOCKTYPE_TRANSFER).toBe(1);
        expect(BlockType.BLOCKTYPE_REWARD).toBe(2);
        expect(BlockType.BLOCKTYPE_TOKEN_CREATION).toBe(3);
        expect(BlockType.BLOCKTYPE_USERDATA).toBe(4);
        expect(BlockType.BLOCKTYPE_CONTRACT_EVENT).toBe(5);
        expect(BlockType.BLOCKTYPE_GOVERNANCE).toBe(6);
        expect(BlockType.BLOCKTYPE_FILE).toBe(7);
        expect(BlockType.BLOCKTYPE_CONTRACT_EXECUTE).toBe(8);
        expect(BlockType.BLOCKTYPE_CROSSTANGLE).toBe(9);
        expect(BlockType.BLOCKTYPE_ORDER_OPEN).toBe(10);
        expect(BlockType.BLOCKTYPE_ORDER_CANCEL).toBe(11);
        expect(BlockType.BLOCKTYPE_ORDER_EXECUTE).toBe(12);
        expect(BlockType.BLOCKTYPE_CONTRACTEVENT_CANCEL).toBe(13);
  });
});
