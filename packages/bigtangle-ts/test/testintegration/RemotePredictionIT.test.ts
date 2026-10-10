import { describe, test, expect, beforeEach } from "vitest";
import { RemoteTest } from "./RemoteTest";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { PredictionAction, PredictionMarketConfig } from "../../src/net/bigtangle/apps/prediction/PredictionMarket";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Port of Java RemotePredictionIT (../blockchain layer0-server .../remote):
 * L1-prediction is a fully separated chain - all operations (token creation,
 * contract events, engine execution via beacon confirmation) run on the
 * L1-prediction server. Exercised lifecycle: create -> split -> merge (the
 * non-timed happy path; resolver/dispute ladder is time-dependent and covered
 * by PredictionEngineTest on the Java side).
 */
class RemotePredictionTests extends RemoteTest {
  private l1pUrl = process.env.TEST_L1P_URL || "http://localhost:24088/";

  private static readonly SUPPLY = BigInt(1000000);
  private static readonly SPLIT_AMOUNT = BigInt(100000);

  // Fixed resolver committee seeds (outside the harness' 0x01..0x06 range).
  private static readonly COMMITTEE_SEED_BASE = 0x21;
  private static readonly COMMITTEE_SIZE = 3;

  constructor() {
    super();
    // All operations run against the L1-prediction server.
    this.contextRoot = this.l1pUrl;
  }

  private static fixedKey(seed: number): PQKey {
    const seedBytes = new Uint8Array(32).fill(seed);
    return PQKey.fromMLDSA(seedBytes);
  }

  private committeeAddresses(): string[] {
    const addrs: string[] = [];
    for (let i = 0; i < RemotePredictionTests.COMMITTEE_SIZE; i++) {
      const k = RemotePredictionTests.fixedKey(RemotePredictionTests.COMMITTEE_SEED_BASE + i);
      addrs.push(k.toAddressString(this.networkParameters));
    }
    return addrs;
  }

  /** create -> split -> merge against a fresh market per run (random ids). */
  async testCreateSplitMergeLifecycle() {
    // Fresh market per run: random ids so re-runs never inherit a
    // finalized/expired vault state.
    const yesKey = PQKey.createNew();
    const noKey = PQKey.createNew();
    const contractKey = PQKey.createNew();
    const yesId = yesKey.getPublicKeyAsHex();
    const noId = noKey.getPublicKeyAsHex();
    const contractId = contractKey.getPublicKeyAsHex();
    const bc = NetworkParameters.BIGTANGLE_TOKENID_STRING;
    const supply = RemotePredictionTests.SUPPLY;
    const splitAmount = RemotePredictionTests.SPLIT_AMOUNT;

    await this.waitForConfirmedBalance(bc, [yesKey], 120000);
    expect((await this.tokenBalance(yesKey, bc)) > 0n, "operator should hold BC").toBe(true);

    // 1. YES + NO: fixed supply S, tokenstop (no re-issuance).
    await this.createFixedSupplyToken(yesKey, yesId, "PREDYES", supply);
    await this.createFixedSupplyToken(noKey, noId, "PREDNO", supply);
    const hasSupply = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) >= supply &&
      (await this.tokenBalance(noKey, noId)) >= supply, 60);
    expect(hasSupply, "operator should hold the full YES+NO supply").toBe(true);

    // 2. Contract token: config key-values only (no amount/token constraints).
    const resolutionTimeSec = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    await this.createPredictionContract(contractKey, contractId, yesId, noId, resolutionTimeSec);
    const contractToken = await this.waitForToken(contractId, 60);
    expect(contractToken, "contract token should exist on the prediction chain").not.toBeNull();

    // The operator wallet (the key that holds YES/NO) submits the events.
    const w = Wallet.fromKeysURL(this.networkParameters, [yesKey, noKey, contractKey], this.contextRoot);
    w.importKey(yesKey);
    w.importKey(noKey);
    w.importKey(contractKey);

    // 3. create: escrow the pre-minted S YES + S NO into the vault.
    const createBurns = new Map<string, bigint>();
    createBurns.set(yesId, supply);
    createBurns.set(noId, supply);
    await w.payContractMulti(null, createBurns, yesId, supply, null, null,
      contractId, PredictionAction.create());
    const created = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) === 0n && (await this.tokenBalance(noKey, noId)) === 0n, 90);
    expect(created, "create should burn the full YES+NO supply into the vault").toBe(true);

    // 4. split: burn C collateral -> vault pays C YES + C NO.
    const bcBeforeSplit = await this.tokenBalance(yesKey, bc);
    const splitBurns = new Map<string, bigint>();
    splitBurns.set(bc, splitAmount);
    await w.payContractMulti(null, splitBurns, bc, splitAmount, null, null,
      contractId, PredictionAction.split());
    const splitPaid = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) >= splitAmount &&
      (await this.tokenBalance(noKey, noId)) >= splitAmount, 90);
    expect(splitPaid, "split should pay out YES+NO from the vault").toBe(true);
    expect(await this.tokenBalance(yesKey, yesId)).toBe(splitAmount);
    expect(await this.tokenBalance(noKey, noId)).toBe(splitAmount);
    console.log(`split confirmed: YES=NO=${splitAmount} (bc spent ${bcBeforeSplit - (await this.tokenBalance(yesKey, bc))})`);

    // 5. merge: burn C YES + C NO -> vault pays C collateral.
    const bcBeforeMerge = await this.tokenBalance(yesKey, bc);
    const mergeBurns = new Map<string, bigint>();
    mergeBurns.set(yesId, splitAmount);
    mergeBurns.set(noId, splitAmount);
    await w.payContractMulti(null, mergeBurns, yesId, splitAmount, null, null,
      contractId, PredictionAction.merge());
    const merged = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) === 0n && (await this.tokenBalance(noKey, noId)) === 0n, 90);
    expect(merged, "merge should burn the YES+NO pair back into the vault").toBe(true);
    // Payout of SPLIT_AMOUNT minus the merge fee tx (FEE_DEFAULT = 1000).
    const bcAfterMerge = await this.tokenBalance(yesKey, bc);
    expect(bcAfterMerge >= bcBeforeMerge + splitAmount - BigInt(5000),
      `merge should return the collateral (balance ${bcAfterMerge} vs before ${bcBeforeMerge})`).toBe(true);
    console.log(`merge confirmed: collateral returned (bc ${bcBeforeMerge} -> ${bcAfterMerge})`);
  }

  /**
   * Phase 4: a staked-optimistic market (no committee) accepts the config
   * on-chain and runs the same create/split path; the engine resolves it via
   * the bonded propose/challenge/vote ladder (covered by PredictionEngineTest).
   */
  async testStakedMarketCreateSplit() {
    const yesKey = PQKey.createNew();
    const noKey = PQKey.createNew();
    const contractKey = PQKey.createNew();
    const yesId = yesKey.getPublicKeyAsHex();
    const noId = noKey.getPublicKeyAsHex();
    const contractId = contractKey.getPublicKeyAsHex();
    const bc = NetworkParameters.BIGTANGLE_TOKENID_STRING;
    const supply = RemotePredictionTests.SUPPLY;
    const splitAmount = RemotePredictionTests.SPLIT_AMOUNT;

    await this.waitForConfirmedBalance(bc, [yesKey], 120000);

    await this.createFixedSupplyToken(yesKey, yesId, "SPREDYES", supply);
    await this.createFixedSupplyToken(noKey, noId, "SPREDNO", supply);
    const hasSupply = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) >= supply &&
      (await this.tokenBalance(noKey, noId)) >= supply, 60);
    expect(hasSupply, "operator should hold the full supply").toBe(true);

    const resolutionTimeSec = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    await this.createPredictionContract(contractKey, contractId, yesId, noId, resolutionTimeSec, true);
    const contractToken = await this.waitForToken(contractId, 60);
    expect(contractToken, "staked contract token should exist").not.toBeNull();

    const w = Wallet.fromKeysURL(this.networkParameters, [yesKey, noKey, contractKey], this.contextRoot);
    w.importKey(yesKey);
    w.importKey(noKey);
    w.importKey(contractKey);

    const createBurns = new Map<string, bigint>();
    createBurns.set(yesId, supply);
    createBurns.set(noId, supply);
    await w.payContractMulti(null, createBurns, yesId, supply, null, null, contractId, PredictionAction.create());
    const created = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) === 0n && (await this.tokenBalance(noKey, noId)) === 0n, 90);
    expect(created, "create should escrow the full YES+NO supply").toBe(true);

    const splitBurns = new Map<string, bigint>();
    splitBurns.set(bc, splitAmount);
    await w.payContractMulti(null, splitBurns, bc, splitAmount, null, null, contractId, PredictionAction.split());
    const splitPaid = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) >= splitAmount &&
      (await this.tokenBalance(noKey, noId)) >= splitAmount, 90);
    expect(splitPaid, "staked split should pay out YES+NO").toBe(true);
    console.log(`staked market split confirmed: YES=NO=${splitAmount}`);
  }

  /**
   * Phase 5: a multi-outcome market (N winner-take-all tokens) runs the same
   * complete-set path as a binary market: create escrows S of every outcome,
   * split of C collateral mints C of every outcome, and merge burns a full
   * complete set back to C collateral.
   */
  async testMultiOutcomeCreateSplitMerge() {
    const yesKey = PQKey.createNew();
    const aKey = PQKey.createNew();
    const bKey = PQKey.createNew();
    const contractKey = PQKey.createNew();
    const yesId = yesKey.getPublicKeyAsHex();
    const aId = aKey.getPublicKeyAsHex();
    const bId = bKey.getPublicKeyAsHex();
    const contractId = contractKey.getPublicKeyAsHex();
    const outcomes = [yesId, aId, bId];
    const bc = NetworkParameters.BIGTANGLE_TOKENID_STRING;
    const supply = RemotePredictionTests.SUPPLY;
    const splitAmount = RemotePredictionTests.SPLIT_AMOUNT;

    await this.waitForConfirmedBalance(bc, [yesKey], 120000);

    await this.createFixedSupplyToken(yesKey, yesId, "MPREDA", supply);
    await this.createFixedSupplyToken(aKey, aId, "MPREDB", supply);
    await this.createFixedSupplyToken(bKey, bId, "MPREDC", supply);
    const hasSupply = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) >= supply &&
      (await this.tokenBalance(aKey, aId)) >= supply &&
      (await this.tokenBalance(bKey, bId)) >= supply, 60);
    expect(hasSupply, "operator should hold the full supply of all three outcomes").toBe(true);

    const resolutionTimeSec = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    await this.createMultiOutcomeContract(contractKey, contractId, outcomes, resolutionTimeSec);
    const contractToken = await this.waitForToken(contractId, 60);
    expect(contractToken, "multi-outcome contract token should exist").not.toBeNull();

    const w = Wallet.fromKeysURL(this.networkParameters, [yesKey, aKey, bKey, contractKey], this.contextRoot);
    for (const k of [yesKey, aKey, bKey, contractKey]) w.importKey(k);

    // create: escrow S of every outcome into the vault
    const createBurns = new Map<string, bigint>();
    for (const outcome of outcomes) createBurns.set(outcome, supply);
    await w.payContractMulti(null, createBurns, yesId, supply, null, null, contractId, PredictionAction.create());
    const created = await this.waitFor(async () =>
      (await this.tokenBalance(yesKey, yesId)) === 0n &&
      (await this.tokenBalance(aKey, aId)) === 0n &&
      (await this.tokenBalance(bKey, bId)) === 0n, 90);
    expect(created, "create should burn the full supply of every outcome into the vault").toBe(true);

    // split: burn C collateral -> vault pays C of EACH outcome (to the collateral holder)
    const bcBeforeSplit = await this.tokenBalance(yesKey, bc);
    const splitBurns = new Map<string, bigint>();
    splitBurns.set(bc, splitAmount);
    await w.payContractMulti(null, splitBurns, bc, splitAmount, null, null, contractId, PredictionAction.split());
    const splitPaid = await this.waitFor(async () => {
      for (const outcome of outcomes) {
        if ((await this.tokenBalance(yesKey, outcome)) < splitAmount) return false;
      }
      return true;
    }, 90);
    expect(splitPaid, "split should pay out every outcome from the vault").toBe(true);
    for (const outcome of outcomes) {
      expect(await this.tokenBalance(yesKey, outcome)).toBe(splitAmount);
    }
    console.log(`multi-outcome split confirmed: ${outcomes.length} outcomes = ${splitAmount} (bc spent ${bcBeforeSplit - (await this.tokenBalance(yesKey, bc))})`);

    // merge: burn C of every outcome (a complete set) -> vault pays C collateral
    const bcBeforeMerge = await this.tokenBalance(yesKey, bc);
    const mergeBurns = new Map<string, bigint>();
    for (const outcome of outcomes) mergeBurns.set(outcome, splitAmount);
    await w.payContractMulti(null, mergeBurns, yesId, splitAmount, null, null, contractId, PredictionAction.merge());
    const merged = await this.waitFor(async () => {
      for (const outcome of outcomes) {
        if ((await this.tokenBalance(yesKey, outcome)) !== 0n) return false;
      }
      return true;
    }, 90);
    expect(merged, "merge should burn the complete set back into the vault").toBe(true);
    const bcAfterMerge = await this.tokenBalance(yesKey, bc);
    expect(bcAfterMerge >= bcBeforeMerge + splitAmount - BigInt(5000),
      `merge should return the collateral (balance ${bcAfterMerge} vs before ${bcBeforeMerge})`).toBe(true);
    console.log(`multi-outcome merge confirmed: collateral returned (bc ${bcBeforeMerge} -> ${bcAfterMerge})`);
  }

  private async createFixedSupplyToken(issuer: PQKey, tokenId: string, name: string, supply: bigint) {
    const existing = await this.getToken(tokenId);
    if (existing != null) {
      console.log(`reusing token ${name} (${tokenId})`);
      return;
    }
    // increment=false -> tokenstop=true: fixed supply, no re-issuance.
    const block = await this.createToken(issuer, name, 0, "", "prediction test token",
      supply, false, null, TokenType.token, tokenId);
    expect(block, `createToken should return a block for ${name}`).not.toBeNull();
    await this.multiSignToken(tokenId);
    console.log(`token ${name} created (supply ${supply}, tokenstop)`);
  }

  private async createPredictionContract(issuer: PQKey, contractId: string, yesId: string, noId: string,
    resolutionTimeSec: number, staked = false) {
    const existing = await this.getToken(contractId);
    if (existing != null) {
      console.log(`reusing contract token ${contractId}`);
      return;
    }
    const keyValues = PredictionMarketConfig.keyValues(staked ? {
      supply: RemotePredictionTests.SUPPLY,
      collateralTokenid: NetworkParameters.BIGTANGLE_TOKENID_STRING,
      yesTokenid: yesId,
      noTokenid: noId,
      question: "will the staked prediction IT pass?",
      resolutionTimeSec,
      disputeWindowSec: 300,
      autoInvalidSec: 86400,
      disputeBond: 0n,
      oracle: 'staked',
      proposalBond: 1000n,
      voteWindowSec: 300,
    } : {
      supply: RemotePredictionTests.SUPPLY,
      collateralTokenid: NetworkParameters.BIGTANGLE_TOKENID_STRING,
      yesTokenid: yesId,
      noTokenid: noId,
      question: "will the prediction IT pass?",
      resolutionTimeSec,
      disputeWindowSec: 300,
      autoInvalidSec: 86400,
      disputeBond: 0n,
      committeeAddresses: this.committeeAddresses(),
    });
    const block = await this.createToken(issuer, "PREDICT", 0, "", "prediction market contract",
      0n, false, keyValues, TokenType.contract, contractId);
    expect(block, "contract token creation should return a block").not.toBeNull();
    await this.multiSignToken(contractId);
    console.log(`prediction contract token created${staked ? ' (staked)' : ''}: ${contractId}`);
  }

  private async createMultiOutcomeContract(issuer: PQKey, contractId: string, outcomes: string[],
    resolutionTimeSec: number) {
    const existing = await this.getToken(contractId);
    if (existing != null) {
      console.log(`reusing contract token ${contractId}`);
      return;
    }
    const keyValues = PredictionMarketConfig.keyValues({
      supply: RemotePredictionTests.SUPPLY,
      collateralTokenid: NetworkParameters.BIGTANGLE_TOKENID_STRING,
      outcomeTokenids: outcomes,
      question: "which multi-outcome IT wins?",
      resolutionTimeSec,
      disputeWindowSec: 300,
      autoInvalidSec: 86400,
      disputeBond: 0n,
      committeeAddresses: this.committeeAddresses(),
    });
    const block = await this.createToken(issuer, "MPREDICT", 0, "", "multi-outcome prediction market contract",
      0n, false, keyValues, TokenType.contract, contractId);
    expect(block, "multi-outcome contract token creation should return a block").not.toBeNull();
    await this.multiSignToken(contractId);
    console.log(`multi-outcome prediction contract token created: ${contractId} (${outcomes.length} outcomes)`);
  }

  private async multiSignToken(tokenId: string) {
    // The issuer signed at createToken time; the pending multisign is the
    // domain key (walletKeys[0]), which is what makes the block solid.
    const domainKey = (await this.wallet.walletKeys(null))[0];
    let signed: Block | null = null;
    for (let attempt = 0; attempt < 10 && signed == null; attempt++) {
      signed = await this.wallet.multiSign(tokenId, domainKey, null);
      if (signed == null) await sleep(2000);
    }
  }

  private async createToken(
    key: PQKey,
    tokenname: string,
    decimals: number,
    domainname: string,
    description: string,
    amount: bigint,
    increment: boolean,
    tokenKeyValues: any,
    tokentype: TokenType,
    tokenid: string
  ): Promise<Block> {
    this.wallet.importKey(key);
    const token = new Token();
    token.setTokenid(tokenid);
    token.setTokenname(tokenname);
    token.setDescription(description);
    token.setDecimals(decimals);
    token.setAmount(amount);
    token.setTokenstop(!increment);
    token.setTokentype(tokentype);
    if (tokenKeyValues) {
      token.setTokenKeyValues(tokenKeyValues);
    }
    const addresses = [new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes()))];
    return await this.wallet.createToken(
      key,
      domainname,
      increment,
      token,
      addresses,
      key.getPubKey(),
      new MemoInfo("coinbase")
    );
  }

  private async getToken(tokenid: string): Promise<Token | null> {
    try {
      const res = await fetch(this.contextRoot + "getTokenById", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenid }),
      });
      const data: any = await res.json();
      if (data.tokens && data.tokens.length > 0) {
        return data.tokens[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  private async waitForToken(tokenId: string, attempts: number): Promise<Token | null> {
    for (let i = 0; i < attempts; i++) {
      const t = await this.getToken(tokenId);
      if (t != null) return t;
      await sleep(2000);
    }
    return null;
  }

  /** Confirmed balance of one specific token for a single key. */
  private async tokenBalance(key: PQKey, tokenid: string): Promise<bigint> {
    let sum = 0n;
    for (const utxo of await this.getBalanceByKey(false, key)) {
      if (utxo.getTokenId() === tokenid) sum += utxo.getValue().getValue();
    }
    return sum;
  }

  /** Poll {@code check} every 2s, up to {@code attempts} times. */
  private async waitFor(check: () => Promise<boolean>, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await check()) return true;
      await sleep(2000);
    }
    return false;
  }
}

describe("RemotePredictionTests", () => {
  const tests = new RemotePredictionTests();

  beforeEach(async () => {
    await tests.setUp();
  });

  test("testCreateSplitMergeLifecycle", async () => {
    await tests.testCreateSplitMergeLifecycle();
  }, 600000);

  test("testStakedMarketCreateSplit", async () => {
    await tests.testStakedMarketCreateSplit();
  }, 600000);

  test("testMultiOutcomeCreateSplitMerge", async () => {
    await tests.testMultiOutcomeCreateSplitMerge();
  }, 600000);
});
