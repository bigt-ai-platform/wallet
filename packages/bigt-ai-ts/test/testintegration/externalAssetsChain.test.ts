import { describe, test, expect, beforeEach } from "vitest";
import { RemoteTest, createKeyFromHex } from "./RemoteTest";
import { PQKey } from "../../src/net/bigt-ai/crypto/pq/PQKey";
import { Token } from "../../src/net/bigt-ai/core/Token";
import { TokenType } from "../../src/net/bigt-ai/core/TokenType";
import { TokenKeyValues } from "../../src/net/bigt-ai/core/TokenKeyValues";
import { KeyValue } from "../../src/net/bigt-ai/core/KeyValue";
import { MultiSignAddress } from "../../src/net/bigt-ai/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigt-ai/core/MemoInfo";
import { Block } from "../../src/net/bigt-ai/core/Block";
import { Utils } from "../../src/net/bigt-ai/core/Utils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real L1-order chain test for the four tradable assets
 * (docs/external-assets-order-trade.md).
 *
 * Runs against the Java-built infra (`e2e/infra.sh up` → `remote.sh infra`), the
 * same chain the other testintegration suites use, so this is the only place the
 * asset design touches a real chain:
 *
 *  - `L1-order` accepts `BLOCKTYPE_TOKEN_CREATION` (production `Layer0Params`
 *    does not), so the four tokens are issued **on the order chain**;
 *  - every token is 6 decimals (one constant; `OrderOpenInfo` price/amount are
 *    `long`, 18 decimals would cap an order at ~9.22 units);
 *  - `asset.*` metadata is carried in `TokenKeyValues`;
 *  - reissuance (mint) works with `increment = true`.
 *
 * Skipped unless `TEST_L1_URL` points at a running order chain:
 *   TEST_L1_URL=http://localhost:18086/ npx vitest run test/testintegration/externalAssetsChain.test.ts
 */

interface AssetSpec {
  symbol: string;
  /** Seed byte → deterministic tokenid across runs (like the Java tests). */
  seed: number;
  tokentype: TokenType;
  assetClass: string;
}

const ASSETS: AssetSpec[] = [
  { symbol: "HKD", seed: 0x30, tokentype: TokenType.currency, assetClass: "stablecoin" },
  { symbol: "USD", seed: 0x31, tokentype: TokenType.currency, assetClass: "stablecoin" },
  { symbol: "GOLD", seed: 0x32, tokentype: TokenType.token, assetClass: "commodity" },
  { symbol: "ETH", seed: 0x33, tokentype: TokenType.token, assetClass: "wrapped" },
];

const DECIMALS = 6;
const MINT_RAW = BigInt(1_000_000); // 1.000000 at 6 dp

class ExternalAssetsChainTests extends RemoteTest {
  private l1Url = process.env.TEST_L1_URL || "http://localhost:24086/";

  constructor() {
    super();
    // ALL calls target the order chain, like RemoteOrderTests.
    this.contextRoot = this.l1Url;
  }

  private keyFor(seed: number): PQKey {
    return createKeyFromHex(seed.toString(16).padStart(2, "0"));
  }

  private keyValues(spec: AssetSpec): TokenKeyValues {
    const values = new TokenKeyValues();
    values.addKeyvalue(new KeyValue("asset.class", spec.assetClass));
    values.addKeyvalue(new KeyValue("asset.symbol", spec.symbol));
    values.addKeyvalue(new KeyValue("asset.decimals", String(DECIMALS)));
    return values;
  }

  private async post(cmd: string, body: unknown): Promise<any> {
    const res = await fetch(this.contextRoot + cmd, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  /** Pending multi-signatures the node still wants for this token. */
  private async pendingSigns(tokenid: string): Promise<number> {
    const res = await this.post("getTokenSignByTokenid", { tokenid });
    return (res.multiSignList ?? []).length;
  }

  /**
   * A token block is only solid once its required signatures are in. The
   * creation is signed by the issuer; the DOMAIN key (walletKeys[0], seed 0x01)
   * is the second required signature, and until it lands the block sits in
   * `getTokenSignByTokenid` and the token index does not move.
   */
  private async drainSignatures(tokenid: string): Promise<void> {
    const domainKey = (await this.wallet.walletKeys(null))[0];
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await this.pendingSigns(tokenid)) === 0) return;
      await this.wallet.multiSign(tokenid, domainKey, null);
      await sleep(3000);
    }
    expect(await this.pendingSigns(tokenid), "token block never collected its signatures").toBe(0);
  }

  async issue(spec: AssetSpec, amountRaw: bigint): Promise<void> {
    const key = this.keyFor(spec.seed);
    const tokenid = key.getPublicKeyAsHex();
    this.wallet.importKey(key);

    const existing: any = await this.post("getTokenById", { tokenid });
    if (!existing?.tokens?.length) {
      const token = new Token();
      token.setTokenid(tokenid);
      token.setTokenname(spec.symbol);
      token.setDescription(`${spec.symbol} issuer asset`);
      token.setDecimals(DECIMALS);
      token.setAmount(amountRaw);
      // increment=true keeps minting open (tokenstop=false). A token created
      // with increment=false can never be reissued.
      token.setTokenstop(false);
      token.setTokentype(spec.tokentype);
      token.setTokenKeyValues(this.keyValues(spec));

      const addresses = [
        new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes())),
      ];
      const block: Block = await this.wallet.createToken(
        key, "", true, token, addresses, key.getPubKey(), new MemoInfo("coinbase"),
      );
      expect(block).not.toBeNull();
    }
    await this.drainSignatures(tokenid);
  }

  private async token(tokenid: string): Promise<Token | null> {
    const res = await this.post("getTokenById", { tokenid });
    const raw = res?.tokens?.[0];
    if (!raw) return null;
    const token = new Token();
    token.setTokenid(raw.tokenid);
    token.setTokenname(raw.tokenname);
    if (raw.decimals != null) token.setDecimals(Number(raw.decimals));
    return token;
  }

  async issueAllAndVerify(): Promise<void> {
    for (const spec of ASSETS) {
      await this.issue(spec, MINT_RAW);
      const token = await this.token(this.keyFor(spec.seed).getPublicKeyAsHex());
      expect(token, `${spec.symbol} must exist on the order chain`).not.toBeNull();
      expect(token!.getTokenname()).toBe(spec.symbol);
      expect(token!.getDecimals()).toBe(DECIMALS);
    }
  }

  /**
   * Mint = reissuance. `getTokenIndex` returns the latest token index: 0 after
   * the creation, 1 after the first reissuance, with a new block hash. That is
   * the chain-level proof that a mint was accepted.
   */
  async reissueAndVerify(): Promise<void> {
    const seed = 0x60 + (Date.now() % 0x1f);
    const spec: AssetSpec = { symbol: "HKD", seed, tokentype: TokenType.currency, assetClass: "stablecoin" };
    const tokenid = this.keyFor(seed).getPublicKeyAsHex();

    await this.issue(spec, MINT_RAW);
    const before = await this.post("getTokenIndex", { tokenid });
    expect(Number(before.tokenindex)).toBe(0);
    const beforeHash = before.blockhash?.bytes ?? before.blockhash;

    // Reissue a larger amount; the token must stay open (tokenstop=false).
    const key = this.keyFor(seed);
    const token = new Token();
    token.setTokenid(tokenid);
    token.setTokenname(spec.symbol);
    token.setDescription(`${spec.symbol} issuer asset`);
    token.setDecimals(DECIMALS);
    token.setAmount(MINT_RAW * BigInt(2));
    token.setTokenstop(false);
    token.setTokentype(spec.tokentype);
    token.setTokenKeyValues(this.keyValues(spec));
    const addresses = [
      new MultiSignAddress(tokenid, "", Utils.HEX.encode(key.getPrefixedPublicKeyBytes())),
    ];
    await this.wallet.createToken(
      key, "", true, token, addresses, key.getPubKey(), new MemoInfo("coinbase"),
    );
    await this.drainSignatures(tokenid);

    let after = before;
    for (let attempt = 0; attempt < 30; attempt++) {
      after = await this.post("getTokenIndex", { tokenid });
      if (Number(after.tokenindex) > 0) break;
      await sleep(2000);
    }
    const afterHash = after.blockhash?.bytes ?? after.blockhash;
    expect(Number(after.tokenindex), "reissuance did not advance the token index").toBe(1);
    expect(afterHash, "reissuance did not produce a new token block").not.toBe(beforeHash);
  }
}

const hasChain = !!process.env.TEST_L1_URL;

describe.skipIf(!hasChain)("ExternalAssetsChain", () => {
  const tests = new ExternalAssetsChainTests();

  beforeEach(async () => {
    await tests.setUp();
  });

  test("issues HKD/USD/GOLD/ETH on L1-order with 6 decimals", async () => {
    await tests.issueAllAndVerify();
  }, 900000);

  test("reissues (mints) an existing asset", async () => {
    await tests.issueAllAndVerify();
    await tests.reissueAndVerify();
  }, 900000);
});
