import { expect } from "vitest";
import { ObjectMapper } from "jackson-js";
import { Buffer } from "buffer";
import { Address } from "../../src/net/bigtangle/core/Address";
import { Block } from "../../src/net/bigtangle/core/Block";
import { Coin } from "../../src/net/bigtangle/core/Coin";
import { ECKey } from "../../src/net/bigtangle/core/ECKey";
import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";
import { UTXO } from "../../src/net/bigtangle/core/UTXO";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { ReqCmd } from "../../src/net/bigtangle/params/ReqCmd";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { GetBalancesResponse } from "../../src/net/bigtangle/response/GetBalancesResponse";
import { GetTokensResponse } from "../../src/net/bigtangle/response/GetTokensResponse";
import { TokenIndexResponse } from "../../src/net/bigtangle/response/TokenIndexResponse";
import { OkHttp3Util } from "../../src/net/bigtangle/utils/OkHttp3Util";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";
import { Json } from "../../src/net/bigtangle/utils/Json";
import { WalletUtil } from "../../src/net/bigtangle/utils/WalletUtil";
export abstract class RemoteTest {
  public objectMapper = new ObjectMapper();
  public contextRoot = process.env.TEST_CONTEXT_ROOT || "http://localhost:18089/";

  /*
   * default wallet which has key testpriv and yuanTokenPriv
   */
  public wallet!: Wallet;

  protected readonly aesKey: any = null;

  protected blocksAddedAll: Block[] = [];

  public static testPub =
    "02721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975";
  public static testPriv =
    "ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f";
  public static yuanTokenPub =
    "02a717921ede2c066a4da05b9cdce203f1002b7e2abeee7546194498ef2fa9b13a";
  public static yuanTokenPriv =
    "8db6bd17fa4a827619e165bfd4b0f551705ef2d549a799e7f07115e5c3abad55";

  networkParameters: NetworkParameters = TestParams.get();

  public async checkTokenAssertTrue(tokenid: string, domainname: string) {
    const getTokensResponse = (await this.post(
      ReqCmd.getTokenById,
      [tokenid],
      GetTokensResponse
    )) as GetTokensResponse;
    const token_ = getTokensResponse.getTokens()![0];
    expect(token_.getDomainName() === domainname).toBeTruthy();
  }

  public setUp() {
    this.wallet = Wallet.fromKeysURL(
      this.networkParameters,
      [ECKey.fromPrivateString(RemoteTest.testPriv)],
      this.contextRoot
    );
  }

  protected async payTestTokenTo(
    beneficiary: ECKey,
    testKey: ECKey,
    amount: bigint,
    addedBlocks: Block[] = []
  ) {
    await this.payTestTokenToAmount(beneficiary, testKey, amount, addedBlocks);
  }

  protected async payBigTo(
    beneficiary: ECKey[],
    amount: bigint,
    addedBlocks: Block[]
  ): Promise<Block> {
    const giveMoneyResult = new Map<string, bigint>();
    for (const b of beneficiary) {
    giveMoneyResult.set(
      b.toAddress(this.networkParameters).toString(),
      amount
    );
  }
    // Convert token ID to Uint8Array
    const tokenIdBytes = Buffer.from(Utils.HEX.decode(NetworkParameters.BIGTANGLE_TOKENID_STRING));
    return this.payList(addedBlocks, giveMoneyResult, tokenIdBytes);
  }

  private async payList(
    addedBlocks: Block[],
    giveMoneyResult: Map<string, bigint>,
    tokenid: Buffer
  ): Promise<Block> {
    const coinList = await this.wallet.calculateAllSpendCandidates(null, false);
    this.logUTXOs(coinList);
    const b = await this.wallet.payMoneyToECKeyList(
      null,
      giveMoneyResult,
      tokenid,
      "payList",
      coinList,
      0,
      0
    );
    // log.debug("block " + (b == null ? "block is null" : b.toString()));
    if (addedBlocks !== null) {
      addedBlocks.push(b!);
    }

    return b!;
  }

  protected async payTestTokenToAmount(
    beneficiary: ECKey,
    testKey: ECKey,
    amount: bigint,
    addedBlocks: Block[]
  ) {
    // Use fee as bigint - no conversion needed
    await this.payBigTo(testKey, CoinConstants.FEE_DEFAULT.getValue(), addedBlocks);

    const giveMoneyTestToken = new Map<string, bigint>();

    giveMoneyTestToken.set(
      beneficiary.toAddress(this.networkParameters).toString(),
      amount
    );
    const w = await Wallet.fromKeysURL(
      this.networkParameters,
      [testKey],
      this.contextRoot
    );

    const tokenidBytes = Buffer.from(Utils.HEX.decode(testKey.getPublicKeyAsHex()));
    const b = await w.payToList(
      null,
      giveMoneyTestToken,
      tokenidBytes,
      ""
    );
    // log.debug("block " + (b == null ? "block is null" : b.toString()));

    addedBlocks.push(b!);

    // Open sell order for test tokens
  }


  protected async sell( walletKeys: ECKey[]): Promise<void> {
    const utxos= await this.getBalanceByKeys(false, walletKeys);
    for (const utxo of utxos) {
      if (utxo.getValue() &&
          utxo.getTokenId() !== NetworkParameters.BIGTANGLE_TOKENID_STRING &&
          utxo.getValue()!.isGreaterThan( CoinConstants.ZERO)) {
        this.wallet.setServerURL(this.contextRoot);
        try {
          const sellOrder = await this.wallet.sellOrder(
            null, // aesKey
            utxo.getTokenId(),
            BigInt(100),
            BigInt(1000),
            null, // validToTime
            null, // validFromTime
            NetworkParameters.BIGTANGLE_TOKENID_STRING,
            true // allowRemainder
          );
          this.blocksAddedAll.push(sellOrder);
        } catch (e) {
          // ignore InsufficientMoneyException and other exceptions
          // console.error(e);
        }
      }
    }
  }



  async makeBuyOrder(
    beneficiary: ECKey,
    tokenId: string,
    buyPrice: number,
    buyAmount: number,
    basetoken: string,
    addedBlocks: Block[]
  ): Promise<Block> {
    const w = await Wallet.fromKeysURL(
      this.networkParameters,
      [beneficiary],
      this.contextRoot
    );
    w.setServerURL(this.contextRoot);
    // Use fee as bigint
    await this.payBigTo(beneficiary, CoinConstants.FEE_DEFAULT.getValue(), addedBlocks);
    const block = await w.buyOrder(
      null, // aesKey
      tokenId,
      BigInt(buyPrice),
      BigInt(buyAmount),
      null, // validToTime
      null, // validFromTime
      basetoken,
      true // allowRemainder
    );
    addedBlocks.push(block);

    return block;
  }

  protected async assertHasAvailableToken(
    testKey: ECKey,
    tokenId_: string,
    amount: bigint
  ) {
    // Asserts that the given ECKey possesses the given amount of tokens
    const balance = await this.getBalanceByKey(false, testKey);
    const hashMap = new Map<string, bigint>();
    for (const o of balance) {
      const value = o.getValue();
      if (!value) continue;

      const tokenId = Utils.toHexString(value.getTokenid());
      const current = hashMap.get(tokenId) || BigInt(0);
      hashMap.set(tokenId, current + value.getValue());
    }

    expect(amount === BigInt(0) ? null : amount).toBe(hashMap.get(tokenId_));
  }

  protected getRandomSha256Hash(): Sha256Hash {
    const rawHashBytes = new Uint8Array(32);
    crypto.getRandomValues(rawHashBytes);
    const sha256Hash = Sha256Hash.wrap(Buffer.from(rawHashBytes.buffer));
    if (sha256Hash === null) {
      throw new Error("Failed to create Sha256Hash");
    }
    return sha256Hash;
  }

  public async adjustSolve(block: Block): Promise<Block> {
    // save block
    const resp = await OkHttp3Util.post(
      this.contextRoot + ReqCmd.adjustHeight,
      Buffer.from(block.bitcoinSerialize())
    );

    const result = this.objectMapper.parse(resp) as { dataHex: string };
    const dataHex = result.dataHex;

    const adjust = this.networkParameters
      .getDefaultSerializer()
      .makeBlock(Buffer.from(Utils.HEX.decode(dataHex)));
    adjust.solve( );
    return adjust;
  }

  protected async getBalance(withZero: boolean = false): Promise<UTXO[]> {
    return this.getBalanceByKeys(withZero, await this.wallet.walletKeys(null));
  }

  public async getBalanceByKey(
    withZero: boolean,
    ecKey: ECKey
  ): Promise<UTXO[]> {
    return this.getBalanceByKeys(withZero, [ecKey]);
  }

  protected getLargeUTXO(outputs: UTXO[]): UTXO {
    // Filter out UTXOs with null values
    const validOutputs = outputs.filter((output) => output.getValue() !== null);

    if (validOutputs.length === 0) {
      throw new Error("No UTXOs with valid Coin values found");
    }

    let a = validOutputs[0];
    for (const b of validOutputs) {
      // Use non-null assertion since we filtered nulls
      if (b.getValue()!.isGreaterThan(a.getValue()!)) {
        a = b;
      }
    }
    return a;
  }

  // get balance for the walletKeys
  // This method is now defined only once
  protected async getBalanceByKeys(
    withZero: boolean,
    keys: ECKey[]
  ): Promise<UTXO[]> {
    console.debug(`Getting balances for ${keys.length} keys`);

    const keyStrHex000 = new Array<string>();

    for (const ecKey of keys) {
      const pubKeyHash = ecKey.getPubKeyHash();
      const hex = Utils.toHexString(Buffer.from(pubKeyHash));
      keyStrHex000.push(hex);
    //  console.debug(`Key hash: ${hex}`);
    }
    const jsonString = Json.jsonmapper().stringify(keyStrHex000);
   // console.debug(`Request JSON: ${jsonString}`);

      // Create Buffer from the JSON string directly
      const buffer = Buffer.from(jsonString, 'utf8');

      console.debug(`Making request to: ${this.contextRoot + ReqCmd.getBalances}`);
      const resp = await OkHttp3Util.post(
        this.contextRoot + ReqCmd.getBalances,
        buffer
      );

   //   console.debug(`Received response (first 200 chars): ${resp.substring(0, 200)}...`);

      if (!resp || resp.trim().length === 0) {
        console.error('Received empty response from server');
        return [];
      }

      // Check if response contains an error
      if (resp.includes('"errorcode"')) {
        console.error(`Server returned error: ${resp}`);
        return [];
      }

      return this.getUTXOs(resp);
  }

  protected   getUTXOs( resp: string):  UTXO[]  { 
      // Parse response and convert plain objects to UTXO instances
      const responseObj: any = Json.jsonmapper().parse(resp);
      let utxos: UTXO[] = [];
      
      if (responseObj.outputs) {
        utxos = responseObj.outputs.map((outputData: any) => {
          return UTXO.fromJSONObject(outputData);
        });
      }
      if (!utxos) {
        return [];
      }
      
      // Filter out spent and pending outputs
      utxos = utxos.filter(utxo =>  
        utxo &&  
        !utxo.isSpent()  && 
        !this.checkSpendpending(utxo)
      );
      this.logUTXOs(utxos);
      return utxos;
    }

  protected logUTXOs(utxos: any[]): void {
    if (utxos && utxos.length > 0) {
      console.log(`Logging ${Math.min(utxos.length, 2)} UTXOs:`);
      for (let i = 0; i < Math.min(utxos.length, 2); i++) {
        console.log(utxos[i].toString());
      }
    } else {
      console.log("No UTXOs to log.");
    }
  }
  protected async getBalanceByToken(
    tokenid: string,
    withZero: boolean,
    keys: ECKey[]
  ): Promise<UTXO | null> {
    const ulist = await this.getBalanceByKeys(withZero, keys);

    for (const u of ulist) {
      if (u.getTokenId() && tokenid === u.getTokenId()) {
        return u;
      }
    }

    return null;
  }
  
  // Translated from Java: protected UTXO getBalance(String tokenid, boolean withZero, List<ECKey> keys)
  protected async getBalanceForToken(
    tokenid: string,
    withZero: boolean,
    keys: ECKey[]
  ): Promise<UTXO> {
    const ulist = await this.getBalanceByKeys(withZero, keys);

    for (const u of ulist) {
      if (tokenid === u.getTokenId()) {
        return u;
      }
    }

    throw new Error("UTXO not found for tokenid: " + tokenid);
  }

  protected async getBalanceAccount(
    withZero: boolean,
    keys: ECKey[]
  ): Promise<UTXO[]> {
     
    return this.getBalanceByKeys(withZero, keys) ;
  }

  public logCoins(list: Coin[]) {
    for (const coin of list) {
      console.debug(
        coin instanceof Coin
          ? coin.toString()
          : `Coin : ${JSON.stringify(coin)}`
      );
    }
  }

 
  
  // Proxy method to access wallet's checkSpendpending
  checkSpendpending(utxo: UTXO): boolean {
    return this.wallet.checkSpendpending(utxo);
  }
  
  // get balance for the walletKeys
  protected async getBalanceByAddress(address: string): Promise<UTXO[]> {
    const listUTXO = new Array<UTXO>();
    const keyStrHex000 = new Array<string>();

    keyStrHex000.push(
      Utils.toHexString(
        Address.fromBase58(this.networkParameters, address)!.getHash160()!
      )
    );
    const getBalancesResponse = (await this.post(
      ReqCmd.getBalances,
      keyStrHex000,
      GetBalancesResponse
    )) as GetBalancesResponse;

    for (const utxo of getBalancesResponse.getOutputs()!) {
      listUTXO.push(utxo);
    }

    return listUTXO;
  }

  protected async getBalanceByECKey(
    withZero: boolean,
    ecKey: ECKey
  ): Promise<UTXO[]> {
    const keys: ECKey[] = [];
    keys.push(ecKey);
    return this.getBalanceByKeys(withZero, keys);
  }
   
 

  protected checkResponse(resp: Uint8Array, code: number = 0) {
    this.checkResponseWithCode(resp, code);
  }

  protected checkResponseWithCode(resp: Uint8Array, code: number) {
    const result2 = this.objectMapper.parse(resp.toString()) as any;
    const error = result2.errorcode as number;
    expect(error === code).toBeTruthy();
  }

 
  protected async checkBalanceSumWithKey(coin: Coin, a: ECKey) {
    const keys: ECKey[] = [];
    keys.push(a);
    await this.checkBalanceSum(coin, keys);
  }

  protected async checkBalanceSum(coin: Coin, a: ECKey[]) {
    const ulist = await this.getBalanceByKeys(false, a);

    let sum = new Coin(BigInt(0), coin.getTokenid());
    for (const u of ulist) {
      if (coin.getTokenHex() === u.getTokenId()) {
        if (u.getValue()) sum = sum.add(u.getValue()!);
      }
    }
    if (coin.getValue() !== sum.getValue()) {
      console.log(" expected: " + coin + " got: " + sum);
    }
    expect(coin.getValue() === sum.getValue()).toBeTruthy();
  } 

  public async getServerCalTokenIndex(
    tokenid: string
  ): Promise<TokenIndexResponse> {
    const requestParam = new Map<string, string>();
    requestParam.set("tokenid", tokenid);
    const resp = await OkHttp3Util.postStringSingle(
      this.contextRoot + ReqCmd.getTokenIndex,
      Buffer.from(this.objectMapper.stringify(Object.fromEntries(requestParam)))
    );
    return this.objectMapper.parse(resp, {
      mainCreator: () => [TokenIndexResponse],
    }) as TokenIndexResponse;
  }





  public async post<T>(
    reqCmd: string,
    params: any, // Changed type to any to accommodate Map and Array
    responseClass: any
  ): Promise<T> {
    return OkHttp3Util.postClass(
      this.contextRoot + reqCmd,
      params,
      responseClass
    );
  }
 
  public async testSearchOrder() { 

      const ordersWithAddress = await WalletUtil.searchOrder(
        this.wallet,
        null,
      null,
        "publish",
        false,
        this.contextRoot
      );
      expect(ordersWithAddress).toBeDefined();
      console.log("Orders with address found:", ordersWithAddress.length);
    }
  }
 
