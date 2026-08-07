import { describe, test, expect } from "vitest";
import { MainNetParams } from "../../src/net/bigtangle/params/MainNetParams";
import { UtilGeneseBlock } from "../../src/net/bigtangle/core/UtilGeneseBlock";

class ParamsWithChainId extends MainNetParams {
  constructor(chainId: string) {
    super();
    this.setChainId(chainId);
  }
}

describe("GenesisHashTest", () => {
  test("testDifferentChainIdsProduceDifferentGenesisHashes", () => {
    const genesisL0 = UtilGeneseBlock.createGenesis(new ParamsWithChainId("L0"));
    const genesisL1 = UtilGeneseBlock.createGenesis(new ParamsWithChainId("L1"));
    expect(genesisL0.getHash().toString()).not.toBe(genesisL1.getHash().toString());
  });

  test("testSameChainIdProducesSameGenesisHash", () => {
    const a = UtilGeneseBlock.createGenesis(new ParamsWithChainId("same"));
    const b = UtilGeneseBlock.createGenesis(new ParamsWithChainId("same"));
    expect(a.getHash().toString()).toBe(b.getHash().toString());
  });
});
