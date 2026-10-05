import { describe, test, expect, beforeEach } from "vitest";
import { RemoteTest } from "./RemoteTest";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { ReqCmd } from "../../src/net/bigtangle/params/ReqCmd";
import { OkHttp3Util } from "../../src/net/bigtangle/utils/OkHttp3Util";
import { Json } from "../../src/net/bigtangle/utils/Json";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { MultiSignAddress } from "../../src/net/bigtangle/core/MultiSignAddress";
import { MemoInfo } from "../../src/net/bigtangle/core/MemoInfo";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { CoinConstants } from "../../src/net/bigtangle/core/CoinConstants";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Port of Java RemoteOrderIT (../blockchain layer0-server .../remote):
 * L1-order is a fully separated chain - wallets, funding, token creation,
 * buy/sell orders and matching all run on the L1-order server.
 *
 * Two tests, matching Java:
 *  - testCreateTokenAndTrade: the fixed CNY quote token traded against BC.
 *  - testCnyBasedTradePairs:  the CNY-based pairs (USD, BTC, ETH, Nvidia,
 *    Apple, BYD vs CNY) with real Binance prices, each sell + buy matched.
 */
class RemoteOrderTests extends RemoteTest {
  private l1Url = process.env.TEST_L1_URL || "http://localhost:18086/";

  // Fixed seeds keep the token ids stable across runs (Java RemoteOrderIT
  // uses the same seeds), so Java and TS share the tokens on one chain.
  // The former "yuan" token (seed 0x03) is left to RemoteFromAddressTests,
  // which already issues 人民币 at that id, and seed 0x04 is the harness' PoS
  // validator key (remote.sh) - so CNY starts at 0x05 and the pairs at 0x06.
  private static readonly CNY_KEY_SEED = 0x05;
  private static readonly PAIR_KEY_SEED_BASE = 0x06;
  private static readonly ORDER_TOKEN_NAME = process.env.ORDER_TOKEN_NAME || "CNY";
  private static readonly PAIR_TOKEN_NAMES = (
    process.env.ORDER_PAIR_TOKENS || "USD,BTC,ETH,Nvidia,Apple,BYD"
  )
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  private static readonly TOKEN_SUPPLY = BigInt(100000000);
  private static readonly ORDER_AMOUNT = BigInt(
    process.env.ORDER_AMOUNT || "100"
  );
  // The CNY/BC price has no Binance market (BC is this chain's own native
  // token), so it keeps the order.price knob; the CNY pairs below do use
  // real Binance prices.
  private static readonly ORDER_PRICE = BigInt(process.env.ORDER_PRICE || "1000");
  private static readonly ORDER_STAGGER_MS = Number(
    process.env.ORDER_STAGGER_MS || "1000"
  );
  private static readonly CNY_PAIRS_ENABLED = (
    process.env.ORDER_CNY_PAIRS || "true"
  ).toLowerCase() !== "false";
  // Real Binance market data: spot ticker first, USDⓈ-M futures for the
  // equity pairs (Nvidia/Apple/BYD are not spot markets on Binance), then a
  // recorded snapshot (2026-10-04) so the test also runs offline.
  // Per token override: ORDER_PRICE_BTC=12345 - force snapshot: ORDER_BINANCE_LIVE=false
  private static readonly BINANCE_TICKERS: Record<string, string[]> = {
    USD: ["https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT"],
    BTC: [
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSD",
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    ],
    ETH: [
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSD",
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
    ],
    Nvidia: ["https://fapi.binance.com/fapi/v1/ticker/price?symbol=NVDAUSDT"],
    Apple: ["https://fapi.binance.com/fapi/v1/ticker/price?symbol=AAPLUSDT"],
    BYD: ["https://fapi.binance.com/fapi/v1/ticker/price?symbol=BYDUSDT"],
  };
  private static readonly BINANCE_SNAPSHOT: Record<string, string> = {
    USD: "1.0001",
    BTC: "85326.65",
    ETH: "2696.75",
    Nvidia: "234.75",
    Apple: "333.38",
    BYD: "9.43",
  };

  constructor() {
    super();
    // Matches Java RemoteOrderIT, which sets contextRoot = l1Url: ALL
    // operations (wallets, funding, token creation, buy/sell orders) run on
    // the L1-order server; L0 is only used for payment/token creation.
    this.contextRoot = this.l1Url;
  }

  /**
   * The fixed CNY quote token traded against BC: the CNY issuer sells CNY for
   * BC and a fresh buyer pays BC. Mirrors Java testOrderMatching.
   */
  async testCreateTokenAndTrade() {
    const amount = RemoteOrderTests.ORDER_AMOUNT;
    const price = RemoteOrderTests.ORDER_PRICE;
    const bc = NetworkParameters.BIGTANGLE_TOKENID_STRING;

    // 1. Fixed CNY issuer (seed 0x05) + one fresh buyer per run.
    const issuer = this.fixedKey(RemoteOrderTests.CNY_KEY_SEED);
    const tokenId = Utils.HEX.encode(issuer.getPrefixedPublicKeyBytes());
    const buyer = PQKey.createNew();
    const issuerWallet = Wallet.fromKeysURL(this.networkParameters, [issuer], this.contextRoot);
    const buyerWallet = Wallet.fromKeysURL(this.networkParameters, [buyer], this.contextRoot);

    // 2. Fund both with BC via real on-chain transactions from the genesis
    //    wallet (matches Java's payBigTo). fundAddresses coinbases are virtual
    //    (not in a block), so orders that spend them cannot be synced to the
    //    L1 order server. One wallet at a time: the genesis wallet would
    //    otherwise re-select the outpoint the previous payment is spending.
    const userFunds = CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);
    for (const key of [issuer, buyer]) {
      await this.payBigTo([key], userFunds, []);
      await this.waitForConfirmedBalance(bc, [key]);
      expect(
        (await this.tokenBalance(key, bc)) > 0n,
        `${key.toAddressString(this.networkParameters)} should hold BC`
      ).toBe(true);
    }
    console.log("Issuer and buyer funded with BC");

    // 3. Reuse the CNY token on the order chain: create it once when missing.
    await this.createOrderTokenIfMissing(issuer, tokenId, RemoteOrderTests.ORDER_TOKEN_NAME);
    await this.waitForConfirmedBalance(tokenId, [issuer]);

    // 4. Sell CNY for BC - price scale = tokenDecimals + priceShift(BC) = 0.
    const scale = (await this.getToken(tokenId))!.getDecimals() + issuerWallet.getOrderPriceShift(bc);
    const rawPrice = this.rawPrice(Number(price), amount, scale);
    issuerWallet.setServerURL(this.contextRoot);
    console.log(`Sell: ${amount} ${RemoteOrderTests.ORDER_TOKEN_NAME} @ price ${rawPrice} (scale ${scale})`);
    await issuerWallet.sellOrder(null, tokenId, rawPrice, amount, null, null, bc, true);

    const stale = (await this.ordersForPair(tokenId, bc)).length;
    const opened = await this.waitFor(
      async () => (await this.ordersForPair(tokenId, bc)).length > stale,
      60
    );
    expect(opened, "the CNY/BC sell order should appear in the order book").toBe(true);
    console.log(`Sell order confirmed: ${(await this.ordersForPair(tokenId, bc)).length} open`);

    // 5. Matching buy from the BC-funded buyer.
    await this.awaitSpendable(buyerWallet, bc, this.totalCost(rawPrice, amount, scale));
    console.log(`Buy: ${amount} ${RemoteOrderTests.ORDER_TOKEN_NAME} @ price ${rawPrice}`);
    await this.placeBuy(buyer, buyerWallet, tokenId, bc, amount, rawPrice);

    // 6. Wait for matching: the pair must drain (a buy can be matched before
    //    it is ever observable as OPEN, so only the empty book proves it).
    const matched = await this.waitFor(
      async () => (await this.ordersForPair(tokenId, bc)).length === 0,
      90
    );
    expect(matched, "CNY/BC orders should all be matched").toBe(true);

    // 7. The matcher payout confirms on its own schedule AFTER the book
    //    empties, so poll instead of checking immediately.
    const bought = await this.waitFor(
      async () => (await this.tokenBalance(buyer, tokenId)) >= amount,
      90
    );
    expect(bought, `buyer should hold ${amount} CNY`).toBe(true);
    const issuerBc = await this.waitFor(
      async () => (await this.totalBc(issuer)) > userFunds,
      90
    );
    expect(issuerBc, "issuer should receive BC from the matched sell").toBe(true);
    console.log(
      `CNY/BC trade completed: buyer holds ${await this.tokenBalance(buyer, tokenId)} CNY, ` +
        `issuer BC ${await this.totalBc(issuer)}`
    );
  }

  /**
   * Create the CNY-based trade pairs with REAL Binance market data: for every
   * pair token the token's fixed issuer offers it for CNY and the CNY issuer
   * buys it with CNY, so each pair (token, CNY) exists on the L1 book AND
   * clears. Mirrors Java testCnyBasedTradePairs. Skip with ORDER_CNY_PAIRS=false.
   */
  async testCnyBasedTradePairs() {
    if (!RemoteOrderTests.CNY_PAIRS_ENABLED) {
      console.log("CNY pair test skipped (ORDER_CNY_PAIRS=false)");
      return;
    }
    const names = RemoteOrderTests.PAIR_TOKEN_NAMES;
    const amount = RemoteOrderTests.ORDER_AMOUNT;
    const cnyKey = this.fixedKey(RemoteOrderTests.CNY_KEY_SEED);
    const cnyId = Utils.HEX.encode(cnyKey.getPrefixedPublicKeyBytes());
    const cnyWallet = Wallet.fromKeysURL(this.networkParameters, [cnyKey], this.contextRoot);
    const pairKeys = names.map((_, i) => this.fixedKey(RemoteOrderTests.PAIR_KEY_SEED_BASE + i));
    const pairIds = pairKeys.map((key) => Utils.HEX.encode(key.getPrefixedPublicKeyBytes()));

    // 1. Real Binance prices, one fetch per pair token.
    const prices: number[] = [];
    for (const name of names) prices.push(await this.binancePrice(name));

    // 2. Create the fixed tokens once, THEN derive the exact order prices:
    //    scale = tokenDecimals + priceShift(base = CNY) = 6 for a 0-decimals
    //    token, and a buy rejects a remainder, so the raw price is rounded up
    //    until price*amount divides exactly.
    for (let i = 0; i < names.length; i++)
      await this.createOrderTokenIfMissing(pairKeys[i], pairIds[i], names[i]);
    await this.createOrderTokenIfMissing(cnyKey, cnyId, RemoteOrderTests.ORDER_TOKEN_NAME);

    const scales: number[] = [];
    const rawPrices: bigint[] = [];
    const costs: bigint[] = [];
    let cnyNeeded = 0n;
    for (let i = 0; i < names.length; i++) {
      const scale =
        (await this.getToken(pairIds[i]))!.getDecimals() + cnyWallet.getOrderPriceShift(cnyId);
      const raw = this.rawPrice(prices[i], amount, scale);
      const cost = this.totalCost(raw, amount, scale);
      scales.push(scale);
      rawPrices.push(raw);
      costs.push(cost);
      cnyNeeded += cost;
      console.log(
        `Pair ${names[i]}: price ${prices[i]} CNY -> raw price ${raw} (scale ${scale}), ` +
          `cost ${cost} CNY for ${amount}`
      );
    }

    // 3. The seller of each pair holds its own token, the CNY issuer holds
    //    the quote currency that buys all of them.
    for (let i = 0; i < names.length; i++)
      await this.ensureSupply(pairKeys[i], pairIds[i], names[i], amount);
    await this.ensureSupply(cnyKey, cnyId, RemoteOrderTests.ORDER_TOKEN_NAME, cnyNeeded);

    // 4. BC margin for every wallet that submits an order (both sides pay the
    //    order fee in BC - only a BC quote has the fee waived).
    const margin = CoinConstants.FEE_DEFAULT.getValue() * BigInt(500);
    for (const key of [cnyKey, ...pairKeys]) {
      if ((await this.totalBc(key)) < margin) {
        await this.payBigTo([key], margin, []);
      }
      await this.waitForConfirmedBalance(
        NetworkParameters.BIGTANGLE_TOKENID_STRING,
        [key]
      );
    }
    console.log(`CNY issuer and ${names.length} pair seller(s) funded with BC`);

    // 5. One pair at a time, each submission spaced by ORDER_STAGGER_MS so no
    //    two ORDER_OPEN txs share a micro-batch block (the L1 matcher only
    //    ever handles transactions.get(0) of such a block).
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const tokenId = pairIds[i];
      const seller = pairKeys[i];
      const sellerWallet = Wallet.fromKeysURL(this.networkParameters, [seller], this.contextRoot);
      const price = rawPrices[i];
      const cost = costs[i];
      const sellerCnyBaseline = await this.tokenBalance(seller, cnyId);
      const buyerXBaseline = await this.tokenBalance(cnyKey, tokenId);
      // Resting orders of this pair from an earlier, interrupted run: the
      // book only has to fall back to them, the balance checks are what prove
      // OUR orders matched.
      const stale = (await this.ordersForPair(tokenId, cnyId)).length;

      await sleep(RemoteOrderTests.ORDER_STAGGER_MS);
      await this.placeSell(sellerWallet, tokenId, cnyId, amount, price, stale);

      await this.awaitSpendable(cnyWallet, cnyId, cost);
      await sleep(RemoteOrderTests.ORDER_STAGGER_MS);
      await this.placeBuy(cnyKey, cnyWallet, tokenId, cnyId, amount, price);

      const matched = await this.waitFor(
        async () => (await this.ordersForPair(tokenId, cnyId)).length <= stale,
        120
      );
      expect(
        matched,
        `pair ${name}/CNY should match: ${(await this.ordersForPair(tokenId, cnyId)).length} ` +
          `order(s) open, ${stale} were already resting`
      ).toBe(true);

      // The matcher payout confirms on its own schedule AFTER the book
      // empties, so poll instead of checking immediately.
      const bought = await this.waitFor(
        async () => (await this.tokenBalance(cnyKey, tokenId)) >= buyerXBaseline + amount,
        90
      );
      expect(
        bought,
        `CNY issuer should buy ${amount} ${name} (holds ${await this.tokenBalance(cnyKey, tokenId)}, ` +
          `baseline ${buyerXBaseline})`
      ).toBe(true);
      const threshold = sellerCnyBaseline + cost / 2n;
      const paid = await this.waitFor(
        async () => (await this.tokenBalance(seller, cnyId)) >= threshold,
        90
      );
      expect(
        paid,
        `${name} seller should receive ${cost} CNY (holds ${await this.tokenBalance(seller, cnyId)}, ` +
          `baseline ${sellerCnyBaseline})`
      ).toBe(true);
      console.log(
        `Pair ${i + 1}/${names.length} ${name} matched: ${amount} ${name} for ${prices[i]} CNY, ` +
          `seller CNY ${sellerCnyBaseline} -> ${await this.tokenBalance(seller, cnyId)}`
      );
    }
    console.log(`All ${names.length} CNY-based trade pairs created and matched`);
  }

  /** A fixed key (ML-DSA seed), so ids and issuers are stable across runs. */
  private fixedKey(seed: number): PQKey {
    return PQKey.fromMLDSA(new Uint8Array(32).fill(seed));
  }

  /** Create the fixed order token once when it is missing on the order chain. */
  private async createOrderTokenIfMissing(
    issuer: PQKey,
    tokenid: string,
    tokenName: string
  ): Promise<void> {
    const existing = await this.getToken(tokenid);
    if (existing != null) {
      console.log(`Reusing existing order token ${tokenName} (${existing.getTokenname()})`);
      return;
    }
    const block = await this.createToken(
      issuer,
      tokenName,
      0,
      "",
      "reusable order token",
      RemoteOrderTests.TOKEN_SUPPLY,
      true,
      null,
      TokenType.token,
      tokenid
    );
    expect(block).not.toBeNull();

    // The issuer signed at createToken time; the pending multisign is the
    // domain key (walletKeys[0]), which is what makes the block solid.
    const domainKey = (await this.wallet.walletKeys(null))[0];
    let signed: Block | null = null;
    for (let attempt = 0; attempt < 10 && signed == null; attempt++) {
      signed = await this.wallet.multiSign(tokenid, domainKey, null);
      if (signed == null) {
        await sleep(2000);
      }
    }
    if (signed == null) {
      console.log("multiSign returned null (may need more time)");
    }

    let found: Token | null = null;
    for (let i = 0; i < 40 && found == null; i++) {
      found = await this.getToken(tokenid);
      if (found == null) await sleep(2000);
    }
    expect(found, `token ${tokenName} (${tokenid}) should exist after creation`).not.toBeNull();
    console.log(`Order token ${tokenName} created once (supply ${RemoteOrderTests.TOKEN_SUPPLY})`);
  }

  /** Make sure the issuer holds at least {@code need} CONFIRMED units of the token. */
  private async ensureSupply(
    issuer: PQKey,
    tokenid: string,
    tokenName: string,
    need: bigint
  ): Promise<void> {
    // Give a previous mint/confirmation a chance before minting again.
    for (let i = 0; i < 15 && (await this.tokenBalance(issuer, tokenid)) < need; i++)
      await sleep(2000);
    if ((await this.tokenBalance(issuer, tokenid)) < need) {
      const mint = need + RemoteOrderTests.TOKEN_SUPPLY;
      console.log(
        `Issuer holds ${await this.tokenBalance(issuer, tokenid)} of the ${tokenName} needed ` +
          `for this run - minting ${mint} more of the same token`
      );
      await this.createToken(
        issuer,
        tokenName,
        0,
        "",
        "",
        mint,
        true,
        null,
        TokenType.token,
        tokenid
      );
      await this.wallet.multiSign(tokenid, (await this.wallet.walletKeys(null))[0], null);
    }
    const has = await this.waitFor(
      async () => (await this.tokenBalance(issuer, tokenid)) >= need,
      90
    );
    expect(has, `issuer should hold at least ${need} confirmed ${tokenName} tokens`).toBe(true);
  }

  /** Confirmed balance of one specific token for a single key. */
  private async tokenBalance(key: PQKey, tokenid: string): Promise<bigint> {
    let sum = 0n;
    for (const utxo of await this.getBalanceByKey(false, key)) {
      if (utxo.getTokenId() === tokenid) sum += utxo.getValue().getValue();
    }
    return sum;
  }

  /** Confirmed BC total of a single key. */
  private async totalBc(key: PQKey): Promise<bigint> {
    return this.tokenBalance(key, NetworkParameters.BIGTANGLE_TOKENID_STRING);
  }

  /**
   * Wait until the wallet can actually fund an order: a spendable (confirmed)
   * UTXO of {@code needed} of {@code tokenid} plus a BC UTXO for the order fee.
   * Mirrors the candidates sellOrder/buyOrder will pick from.
   */
  private async awaitSpendable(w: Wallet, tokenid: string, needed: bigint): Promise<void> {
    const fee = CoinConstants.FEE_DEFAULT.getValue();
    for (let i = 0; i < 90; i++) {
      let tokens = 0n;
      let bc = 0n;
      for (const candidate of await w.calculateAllSpendCandidates(null, false)) {
        const id = candidate.getUTXO().getTokenId();
        if (id === tokenid) tokens += candidate.getValue().getValue();
        else if (id === NetworkParameters.BIGTANGLE_TOKENID_STRING)
          bc += candidate.getValue().getValue();
      }
      if (tokens >= needed && bc >= fee) return;
      await sleep(2000);
    }
    console.warn(`awaitSpendable: wallet still lacks a spendable ${tokenid} (${needed}) / BC UTXO`);
  }

  /** Open orders of exactly the pair (tokenA, tokenB), either orientation. */
  private async ordersForPair(tokenA: string, tokenB: string): Promise<any[]> {
    const resp = await OkHttp3Util.post(
      this.l1Url + ReqCmd.getOrders,
      new TextEncoder().encode(Json.jsonmapper().stringify({}))
    );
    const parsed = JSON.parse(resp);
    const all: any[] = parsed.allOrdersSorted ?? [];
    return all.filter(
      (order) =>
        (order.offerTokenid === tokenA && order.targetTokenid === tokenB) ||
        (order.offerTokenid === tokenB && order.targetTokenid === tokenA)
    );
  }

  /**
   * Place one sell order, retrying until it is visible in the order book for
   * this pair. Safe to retry: sellOrder only submits after the inputs were
   * selected, so an insufficient-money error means nothing was sent.
   */
  private async placeSell(
    w: Wallet,
    tokenId: string,
    baseToken: string,
    amount: bigint,
    price: bigint,
    stale: number
  ): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await this.awaitSpendable(w, tokenId, amount);
      // A late confirmation from an earlier attempt may already be open: never
      // submit a second sell for the same order - the single buy would fill
      // the first one and leave the duplicate resting.
      if ((await this.ordersForPair(tokenId, baseToken)).length > stale) return;
      try {
        const sellTx = await w.sellOrder(null, tokenId, price, amount, null, null, baseToken, true);
        console.log(`Sell submitted: tx ${sellTx.getHash()} (attempt ${attempt})`);
      } catch (e) {
        console.warn(`Sell rejected on attempt ${attempt}: ${e}`);
      }
      if (await this.waitFor(async () => (await this.ordersForPair(tokenId, baseToken)).length > stale, 60))
        return;
    }
    throw new Error(`Sell of ${amount} ${tokenId} never showed up in the order book`);
  }

  /**
   * Submit one buy order, retrying while the buyer UTXO is not spendable yet.
   * Safe to retry: buyOrder only submits after the inputs were selected.
   */
  private async placeBuy(
    buyer: PQKey,
    w: Wallet,
    tokenId: string,
    baseToken: string,
    amount: bigint,
    price: bigint
  ): Promise<void> {
    for (let attempt = 1; attempt <= 60; attempt++) {
      try {
        const buyTx = await w.buyOrder(null, tokenId, price, amount, null, null, baseToken, false);
        console.log(
          `Buy submitted: tx ${buyTx.getHash()} (buyer ${buyer.toAddressString(this.networkParameters)})`
        );
        return;
      } catch (e) {
        console.warn(`Buy rejected on attempt ${attempt}: ${e}`);
        await sleep(2000);
      }
    }
    throw new Error(`Buy of ${amount} ${tokenId} was never accepted (buyer out of ${baseToken})`);
  }

  /**
   * Real Binance market price for a pair token: the spot ticker first, the
   * USDⓈ-M futures ticker for the equity pairs, then the recorded snapshot
   * (2026-10-04) so the test still runs without internet. Binance lists no
   * CNY/CNH market, so the USD ticker value is used directly as this chain's
   * own CNY book number: prices are quoted per whole token and only feed matching.
   */
  private async binancePrice(name: string): Promise<number> {
    const override = process.env[`ORDER_PRICE_${name.toUpperCase()}`];
    if (override != null && override !== "") {
      console.log(`Price for ${name} taken from ORDER_PRICE_${name.toUpperCase()}: ${override}`);
      return Number(override);
    }
    if ((process.env.ORDER_BINANCE_LIVE || "true").toLowerCase() !== "false") {
      for (const url of RemoteOrderTests.BINANCE_TICKERS[name] ?? []) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (!response.ok) continue;
          const body: any = await response.json();
          const price = Number(body.price);
          if (Number.isFinite(price) && price > 0) {
            console.log(`Binance price for ${name}: ${price} (${url})`);
            return price;
          }
        } catch {
          // try the next market, then the snapshot
        }
      }
    }
    const snapshot = RemoteOrderTests.BINANCE_SNAPSHOT[name];
    if (snapshot == null)
      throw new Error(`No Binance market and no snapshot for pair token ${name}`);
    console.warn(`Binance unreachable for ${name} - using snapshot price ${snapshot}`);
    return Number(snapshot);
  }

  /**
   * The raw order price for {@code displayPrice} (per whole token, quoted in
   * the base token) at the order's price scale = tokenDecimals +
   * priceShift(base). Rounded UP to the step that keeps price*amount exactly
   * divisible, because buyOrder is submitted with allowRemainder=false.
   */
  private rawPrice(displayPrice: number, amount: bigint, scale: number): bigint {
    const factor = 10n ** BigInt(scale);
    const step = factor / this.gcd(amount, factor);
    let raw = BigInt(Math.round(displayPrice * 10 ** scale));
    if (raw < 1n) raw = 1n;
    const remainder = raw % step;
    if (remainder !== 0n) raw += step - remainder;
    return raw;
  }

  /** The order's cost, price*amount / 10^scale, exactly as the wallet computes it. */
  private totalCost(price: bigint, amount: bigint, scale: number): bigint {
    return (price * amount) / 10n ** BigInt(scale);
  }

  private gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a < 0n ? -a : a;
  }

  /** Poll {@code check} every 2s, up to {@code attempts} times. */
  private async waitFor(check: () => Promise<boolean>, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await check()) return true;
      await sleep(2000);
    }
    return false;
  }

  private static hydrateToken(raw: any): Token {
    const token = new Token();
    if (raw.tokenid != null) token.setTokenid(raw.tokenid);
    if (raw.tokenname != null) token.setTokenname(raw.tokenname);
    if (raw.description != null) token.setDescription(raw.description);
    if (raw.domainName != null) token.setDomainName(raw.domainName);
    if (raw.domainNameBlockHash != null) token.setDomainNameBlockHash(raw.domainNameBlockHash);
    if (raw.tokenindex != null) token.setTokenindex(raw.tokenindex);
    if (raw.tokentype != null) token.setTokentype(raw.tokentype);
    if (raw.tokenstop != null) token.setTokenstop(raw.tokenstop);
    if (raw.signnumber != null) token.setSignnumber(raw.signnumber);
    if (raw.decimals != null) token.setDecimals(raw.decimals);
    if (raw.revoked != null) token.setRevoked(raw.revoked);
    if (raw.classification != null) token.setClassification(raw.classification);
    if (raw.language != null) token.setLanguage(raw.language);
    if (raw.amount != null) token.setAmount(BigInt(raw.amount));
    if (raw.confirmed != null) token.setConfirmed(raw.confirmed);
    return token;
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
        return RemoteOrderTests.hydrateToken(data.tokens[0]);
      }
      return null;
    } catch {
      return null;
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
}

describe("RemoteOrderTests", () => {
  const tests = new RemoteOrderTests();

  beforeEach(async () => {
    await tests.setUp();
  });

  test("testCreateTokenAndTrade", async () => {
    await tests.testCreateTokenAndTrade();
  }, 600000);

  test("testCnyBasedTradePairs", async () => {
    await tests.testCnyBasedTradePairs();
  }, 1800000);
});
