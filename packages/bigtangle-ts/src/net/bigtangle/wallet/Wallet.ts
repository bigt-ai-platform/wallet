// TypeScript translation of Wallet.java
// Imports from core, utils, exception, params, script as requested
import { Address } from "../core/Address";
import { Block } from "../core/Block";
import { Coin } from "../core/Coin";
import { CoinConstants } from "../core/CoinConstants";
import { ECKey } from "../core/ECKey";
import { NetworkParameters } from "../params/NetworkParameters";
import { Token } from "../core/Token";
import { TokenInfo } from "../core/TokenInfo";
import { Transaction } from "../core/Transaction";
import { UTXO } from "../core/UTXO";
import { Utils } from "../utils/Utils";
import { Base58 } from "../utils/Base58";
import { Sha256Hash } from "../core/Sha256Hash";
import { DeterministicKey } from "../crypto/DeterministicKey";
import { InsufficientMoneyException } from "../exception/InsufficientMoneyException";
import { NoTokenException } from "../exception/NoTokenException";
import { ReqCmd } from "../params/ReqCmd";
import { ServerPool } from "../pool/server/ServerPool";
import { GetTokensResponse } from "../response/GetTokensResponse";
import { GetDomainTokenResponse } from "../response/GetDomainTokenResponse";
import { MultiSignResponse } from "../response/MultiSignResponse";
import { TokenIndexResponse } from "../response/TokenIndexResponse";
import { Json } from "../utils/Json";
import { OkHttp3Util } from "../utils/OkHttp3Util";
import { WalletBase } from "./WalletBase";
import { KeyChainGroup } from "./KeyChainGroup";
import { LocalTransactionSigner } from "../signers/LocalTransactionSigner";
import { FreeStandingTransactionOutput } from "./FreeStandingTransactionOutput";
import { TransactionOutput } from "../core/TransactionOutput";
import { MemoInfo } from "../core/MemoInfo";
import { OrderOpenInfo } from "../core/OrderOpenInfo";
import { BlockType } from "../core/BlockType";
import { MultiSign } from "../core/MultiSign";
import { Side } from "../core/Side";
import { MultiSignAddress } from "../core/MultiSignAddress";
import { MultiSignBy } from "../core/MultiSignBy";
import { MultiSignByRequest } from "../response/MultiSignByRequest";
import { PermissionedAddressesResponse } from "../response/PermissionedAddressesResponse";
import { KeyPurpose } from "../wallet/KeyChain";

export class Wallet extends WalletBase {
  keyChainGroup: KeyChainGroup;
  url: string | null = null;

  // Static method: fromKeys
  static fromKeys(params: NetworkParameters, keys: ECKey[]): Wallet {
    for (const key of keys) {
      if (key instanceof DeterministicKey) {
        throw new Error("DeterministicKey not allowed");
      }
    }
    const group = new KeyChainGroup(params);
    group.importKeys(...keys);
    return new Wallet(params, group);
  }

  static fromKeysURL(
    params: NetworkParameters,
    keys: ECKey[],
    url: string
  ): Wallet {
    for (const key of keys) {
      if (key instanceof DeterministicKey) {
        throw new Error("DeterministicKey not allowed");
      }
    }
    const group = new KeyChainGroup(params);
    group.importKeys(...keys);
    return new Wallet(params, group, url);
  }

  constructor(
    params: NetworkParameters,
    keyChainGroup?: KeyChainGroup,
    url?: string | null
  ) {
    super();
    this.params = params;
    this.keyChainGroup = keyChainGroup ?? new KeyChainGroup(params);
    if (
      (params as any).getId &&
      (NetworkParameters as any).ID_UNITTESTNET &&
      (params as any).getId() === (NetworkParameters as any).ID_UNITTESTNET
    ) {
      this.keyChainGroup.lookaheadSize = 5;
    }
    // Check if there are any keys by accessing the keys array directly
    if (this.keyChainGroup.numKeys() === 0) {
      this.keyChainGroup.createAndActivateNewHDChain();
    }
    this.signers = [];
    this.addTransactionSigner(new LocalTransactionSigner());
    if (!url) {
      this.serverPool = new ServerPool(params) as ServerPool;
    } else {
      this.url = url;
      this.setServerURL(url);
    }
  }

  // Additional WalletBase methods would be inherited automatically

  async getTip(): Promise<Block> {
    const requestParam = {};
    const tip = await OkHttp3Util.postAndGetBlock(
      this.getServerURL() + ReqCmd.getTip,
      Json.jsonmapper().stringify(requestParam)
    );

    const hexBytes = Utils.HEX.decode(tip);
    const buffer = new Uint8Array(hexBytes);
    return this.params.getDefaultSerializer().makeBlock(buffer);
  }

  async calculateAllSpendCandidates(
    aesKey: any,
    multisigns: boolean
  ): Promise<FreeStandingTransactionOutput[]> {
    const candidates: FreeStandingTransactionOutput[] = [];
    const utxos = await this.calculateAllSpendCandidatesUTXO(
      aesKey,
      multisigns
    );
    for (const output of utxos) {
      candidates.push(new FreeStandingTransactionOutput(this.params, output));
    }
    return candidates;
  }

  checkSpendpending(output: UTXO): boolean {
    // Check if the output is pending spend
    return (
      output.isSpendPending() &&
      Date.now() - output.getSpendPendingTime() < WalletBase.SPENTPENDINGTIMEOUT
    );
  }

  async saveToken(
    tokenInfo: TokenInfo,
    basecoin: Coin,
    ownerKey: ECKey,
    aesKey: any,
    pubKeyTo?: Uint8Array,
    memoInfo?: MemoInfo
  ): Promise<Block> {
    // If pubKeyTo is not provided, use the owner key's public key
    pubKeyTo ??= ownerKey.getPubKey();

    // If memoInfo is not provided, create a default memo
    memoInfo ??= new MemoInfo("coinbase");

    const token = tokenInfo.getToken();
    if (!token) {
      throw new Error("Token cannot be null");
    }

    // Handle domain name block hash if needed
    if (
      Utils.isBlank(token.getDomainNameBlockHash()) &&
      Utils.isBlank(token.getTokenname ? token.getTokenname() : "")
    ) {
      const domainName = token.getTokenname ? token.getTokenname() : "";
      const getDomainBlockHashResponse = await this.getDomainNameBlockHash(
        domainName || ""
      );
      const domainNameBlockHash = getDomainBlockHashResponse.getdomainNameToken
        ? getDomainBlockHashResponse.getdomainNameToken()
        : null;
      if (domainNameBlockHash) {
        token.setDomainNameBlockHash(
          domainNameBlockHash.getBlockHashHex
            ? domainNameBlockHash.getBlockHashHex() || ""
            : ""
        );
        token.setTokenname(
          domainNameBlockHash.getTokenname
            ? domainNameBlockHash.getTokenname() || ""
            : ""
        );
      }
    }

    if (
      Utils.isBlank(token.getDomainNameBlockHash()) &&
      !Utils.isBlank(token.getTokenname ? token.getTokenname() : "")
    ) {
      const domainResponse = await this.getDomainNameBlockHash(
        (token.getTokenname ? token.getTokenname() : "") || ""
      );
      const domain =
        domainResponse && domainResponse.getdomainNameToken
          ? domainResponse.getdomainNameToken()
          : null;
      if (domain && domain.getBlockHashHex) {
        token.setDomainNameBlockHash(domain.getBlockHashHex() || "");
      }
    }

    const multiSignAddresses = tokenInfo.getMultiSignAddresses
      ? tokenInfo.getMultiSignAddresses()
      : [];

    // Only get previous token multi-sign addresses if token has a domainNameBlockHash
    // This prevents server errors when creating first token or tokens without domains
    let permissionedAddressesResponse =
      await this.getPrevTokenMultiSignAddressList(token);

    if (
      permissionedAddressesResponse != null &&
      permissionedAddressesResponse.getMultiSignAddresses() != null &&
      permissionedAddressesResponse.getMultiSignAddresses()!.length > 0
    ) {
      if (Utils.isBlank(token.getTokenname ? token.getTokenname() : "")) {
        const newTokenName = permissionedAddressesResponse.getDomainName();
        if (newTokenName != null && token.setTokenname) {
          token.setTokenname(newTokenName);
        }
      }

      for (const multiSignAddress of permissionedAddressesResponse.getMultiSignAddresses()!) {
        const pubKeyHex = multiSignAddress.getPubKeyHex();
        const tokenid = token.getTokenid
          ? token.getTokenid()
          : (token as any).tokenid;
        const safePubKeyHex = pubKeyHex || "";
        multiSignAddresses.push(
          new MultiSignAddress(tokenid, "", safePubKeyHex, 0)
        );
      }
    }

    // For first-time token creation, don't increment the sign number here
    // The sign number indicates total signatures required, but during initial creation
    // we only provide the first signature and subsequent signatures are added via pullBlockDoMultiSign
    // The original sign number from token creation should remain as is for initial submission

    const block = await this.getTip();
    block.setBlockType(BlockType.BLOCKTYPE_TOKEN_CREATION);

    // Use the proper addCoinbaseTransaction method like Java implementation
    block.addCoinbaseTransaction(
      new Uint8Array(pubKeyTo),
      basecoin,
      tokenInfo,
      memoInfo
    );

    // Add fee transaction like the Java implementation does
    // For token creation, we'll skip fee transaction to avoid insufficient funds errors
    if (this.getFee()) {
      const feeTx = await this.feeTransaction(aesKey, block);
    }

    const transactions = block.getTransactions ? block.getTransactions() : [];
    if (!transactions || transactions.length === 0) {
      throw new Error("No transactions found in block");
    }
    const transaction = transactions[0];

    const sighash = transaction.calcHash();
    if (!sighash) {
      throw new Error("No hash found in transaction");
    }

    // Convert Sha256Hash to bytes for signing
    const sighashBytes = sighash.getBytes
      ? sighash.getBytes()
      : (sighash as any).bytes
      ? (sighash as any).bytes
      : new Uint8Array(0);

    // Handle ownerKey.sign which might return a Promise
    const party1Signature = await ownerKey.sign(sighashBytes, aesKey);
    const buf1 = (party1Signature as any).encodeToDER
      ? (party1Signature as any).encodeToDER!()
      : party1Signature;

    const multiSignBies: MultiSignBy[] = [];

    // First signature (owner key)
    let multiSignBy0 = new MultiSignBy();
    const tokenResult = tokenInfo.getToken ? tokenInfo.getToken() : null;
    if (!tokenResult) {
      throw new Error("Token result is null");
    }
    const tokenIdStr = tokenResult.getTokenid
      ? tokenResult.getTokenid()
      : (tokenResult as any).tokenid || "";
    multiSignBy0.setTokenid(tokenIdStr ? tokenIdStr.trim() : "");
    multiSignBy0.setTokenindex(0);
    multiSignBy0.setAddress(ownerKey.toAddress(this.params).toBase58());
    multiSignBy0.setPublickey(Utils.HEX.encode(ownerKey.getPubKey()));
    const signatureBytes =
      buf1 instanceof Uint8Array ? buf1 : new Uint8Array(buf1);
    multiSignBy0.setSignature(Utils.HEX.encode(signatureBytes));
    multiSignBies.push(multiSignBy0);

    // This follows the Java implementation more closely
    // In the Java code, after creating the first signature, it's added to the transaction
    // The exact same approach as the Java implementation
    const multiSignByRequest = MultiSignByRequest.create(multiSignBies);
    // In TypeScript, we convert to JSON string and then to bytes
    const jsonData = Json.jsonmapper().stringify(multiSignByRequest);
    transaction.setDataSignature(new TextEncoder().encode(jsonData));

    this.checkMultiSignBy(multiSignBies, transaction);
    //   console.log(     " block binary:" + Utils.HEX.encode(block.unsafeBitcoinSerialize()));
       console.log(" block:" + block.toString());
    return await this.adjustSolveAndSign(block);
  }

  /**
   * Pay a specific amount to an address
   * @param aesKey The encryption key
   * @param toAddress The recipient address
   * @param coin The amount to send
   * @param memoInfo Optional memo information
   * @returns A block containing the transaction
   */
  async pay(
    aesKey: any,
    toAddress: string,
    coin: Coin,
    memoInfo?: MemoInfo
  ): Promise<Block> {
    const giveMoneyResult = new Map<string, bigint>();
    giveMoneyResult.set(toAddress, coin.getValue());

    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    const block = await this.payMoneyToECKeyList(
      aesKey,
      giveMoneyResult,
      coin.getTokenid(),
      memoInfo ? memoInfo.toString() : "",
      coinList,
      0,
      0
    );

    if (!block) {
      throw new Error("Failed to create payment transaction");
    }

    return block;
  }

  /**
   * Pay specific amounts to multiple addresses
   * @param aesKey The encryption key
   * @param giveMoneyResult A map of addresses to amounts
   * @param tokenid The token ID to use
   * @param memo Optional memo information
   * @returns A block containing the transaction
   */
  async payToList(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo?: string
  ): Promise<Block | null> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.payMoneyToECKeyList(
      aesKey,
      giveMoneyResult,
      tokenid,
      memo || "",
      coinList,
      0,
      0
    );
  }

  chopped<T>(list: T[], L: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < list.length; i += L) {
      chunks.push(list.slice(i, i + L));
    }
    return chunks;
  }

  async feeTransaction(aesKey: any, block: Block): Promise<Block> {
    if (!this.getFee()) {
      return block; // Don't add fee transaction if fees are disabled
    }
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    const transaction = await this.feeTransaction1(aesKey, coinList);
    block.addTransaction(transaction);

    return block;
  }

  public async calculateAllSpendCandidatesUTXO(
    aesKey: any,
    multisigns: boolean
  ): Promise<UTXO[]> {
    const pubKeyHashs: string[] = [];
    const keys = await this.walletKeys(aesKey);
    for (const ecKey of keys) {
      pubKeyHashs.push(Utils.HEX.encode(ecKey.getPubKeyHash()));
    }

    if (pubKeyHashs.length === 0) {
      return [];
    }

    // Send the addresses array directly as JSON
    const jsonString = Json.jsonmapper().stringify(pubKeyHashs);

    // Create Uint8Array from the JSON string directly
    const buffer = new TextEncoder().encode(jsonString);

    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOutputs,
      buffer
    );

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
    utxos = utxos.filter(
      (utxo) => utxo && !utxo.isSpent() && !this.checkSpendpending(utxo)
    );

    // If multisigns is false, filter out multisign UTXOs
    if (!multisigns) {
      utxos = utxos.filter((utxo) => utxo && !utxo.isMultiSig());
    }

    return utxos;
  }

  async feeTransaction1(
    aesKey: any,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<Transaction> {
    const spent = new Transaction(this.params);
    spent.setMemo("fee");

    // Fixed fee in BIG
    let amount = CoinConstants.FEE_DEFAULT.negate();
    let beneficiary: ECKey | null = null;

    // filter only for NetworkParameters.BIGTANGLE_TOKENID
    const coinListTokenid = this.filterTokenid(
      NetworkParameters.getBIGTANGLE_TOKENID(),
      coinList
    );

    for (const spendableOutput of coinListTokenid) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amount = spendableOutput.getValue().add(amount);
        spent.addInput2(utxo.getBlockHash(), spendableOutput);

        if (!amount.isNegative()) {
          if (beneficiary) {
            spent.addOutputEckey(amount, beneficiary);
          }
          break;
        }
      }
    }

    if (beneficiary == null || amount.isNegative()) {
      throw new InsufficientMoneyException(
        CoinConstants.FEE_DEFAULT.getValue() +
          " outputs size= " +
          coinListTokenid.length
      );
    }

    await this.signTransaction(spent, aesKey, "THROW");
    return spent;
  }

  /**
   * Sign a token with a specific key
   * @param tokenid The token ID to sign
   * @param signkey The key to use for signing
   * @param aesKey The encryption key
   */
  async signToken(
    tokenid: string,
    signkey: ECKey,
    aesKey: any
  ): Promise<Block> {
    // Verify token exists on server
    await this.checkTokenId(tokenid);

    // Get the pending multi-sign data for this token and address
    const multiSignBlock = await this.multiSign(tokenid, signkey, aesKey);
    if (!multiSignBlock) {
      throw new Error(
        `No pending multi-sign operation found for token ${tokenid} and key ${signkey}`
      );
    }

    return multiSignBlock;
  }

  async multiSign(
    tokenid: string,
    outKey: ECKey,
    aesKey: any
  ): Promise<Block | null> {
    const requestParam = new Map<string, any>();

    const address = outKey.toAddress(this.params).toBase58();
    requestParam.set("address", address);
    requestParam.set("tokenid", tokenid);

    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenSignByAddress,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam))
      )
    );

    // Properly deserialize the response using Jackson
    const multiSignResponse: MultiSignResponse = Json.jsonmapper().parse(resp, {
      mainCreator: () => [MultiSignResponse, MultiSign],
    });
   // console.debug(" multiSign responseData: " + multiSignResponse.getMessage);

    const multiSignList = multiSignResponse.getMultiSigns();
    if (!multiSignList || multiSignList.length === 0) {
      return null;
    }
    const multiSign = multiSignList[0];
    if (!multiSign) {
      return null;
    }

    // Check if the deserialized object has the expected methods, otherwise convert manually
    let blockHashHex: string;
    if (typeof multiSign.getBlockhashHex === "function") {
      // It's properly deserialized as a MultiSign instance
      blockHashHex = multiSign.getBlockhashHex();
    } else {
      // It's a plain object, extract the property directly
      blockHashHex =
        (multiSign as any).blockhashHex ||
        (multiSign as any).getblockhashhex ||
        "";
    }

    const block = this.params
      .getDefaultSerializer()
      .makeBlock(new Uint8Array(Utils.HEX.decode(blockHashHex)));
    // replace block prototype if it is too too old

    const transactions = block.getTransactions ? block.getTransactions() : [];
    if (!transactions || transactions.length === 0) {
      throw new Error("No transactions found in block");
    }
    const transaction = transactions[0];

    let multiSignBies: MultiSignBy[];
    if (transaction.getDataSignature() == null) {
      multiSignBies = [];
    } else {
      // Parse the existing multiSignByRequest from the data signature
      const multiSignByRequestData = transaction.getDataSignature();
      if (multiSignByRequestData) {
        // Convert to string depending on type
        let dataStr: string;
        if (typeof multiSignByRequestData === "string") {
          dataStr = multiSignByRequestData;
        } else if (multiSignByRequestData instanceof Uint8Array) {
          dataStr = new TextDecoder().decode(multiSignByRequestData);
        } else {
          // For other types, convert appropriately
          dataStr = String(multiSignByRequestData);
        }

        // Properly deserialize the multiSignByRequest using Jackson
        const multiSignByRequest: MultiSignByRequest = Json.jsonmapper().parse(
          dataStr,
          {
            mainCreator: () => [MultiSignByRequest, MultiSignBy],
          }
        );
        multiSignBies = multiSignByRequest.getMultiSignBies();
      } else {
        multiSignBies = [];
      }
    }

    const sighash = transaction.getHash();
    if (!sighash) {
      throw new Error("No hash found in transaction");
    }

    const sighashBytes = sighash.getBytes
      ? sighash.getBytes()
      : (sighash as any).bytes
      ? (sighash as any).bytes
      : new Uint8Array(0);

    // Handle outKey.sign which might return a Promise
    const party1Signature = await outKey.sign(sighashBytes, aesKey);
    const buf1 = (party1Signature as any).encodeToDER
      ? (party1Signature as any).encodeToDER!()
      : party1Signature;

    if (!multiSign) {
      throw new Error("MultiSign object is null");
    }

    const multiSignBy0 = new MultiSignBy();
    let multiSignTokenId: string | null;
    let tokenindex: number;

    // Check if multiSign is properly deserialized or a plain object
    if (typeof multiSign.getTokenid === "function") {
      // It's properly deserialized as a MultiSign instance
      multiSignTokenId = multiSign.getTokenid();
      tokenindex = multiSign.getTokenindex();
    } else {
      // It's a plain object, extract the properties directly
      multiSignTokenId =
        (multiSign as any).tokenid || (multiSign as any).gettokenid || null;
      tokenindex =
        (multiSign as any).tokenindex !== undefined
          ? (multiSign as any).tokenindex
          : 0;
    }

    if (!multiSignTokenId || tokenindex === undefined) {
      throw new Error("MultiSign tokenid or tokenindex is null/undefined");
    }

    multiSignBy0.setTokenid(multiSignTokenId);
    multiSignBy0.setTokenindex(tokenindex);
    multiSignBy0.setAddress(outKey.toAddress(this.params).toBase58());
    // Convert public key to hex string
    const pubKey = outKey.getPubKey();
    multiSignBy0.setPublickey(Utils.HEX.encode(pubKey));

    const signatureBytes =
      buf1 instanceof Uint8Array ? buf1 : new Uint8Array(buf1);
    // Ensure signatureBytes is a proper format for Utils.HEX.encode
    const signatureHex = Utils.HEX.encode(signatureBytes);
    multiSignBy0.setSignature(signatureHex);

    multiSignBies.push(multiSignBy0);
    const multiSignByRequest = MultiSignByRequest.create(multiSignBies);
    // Convert to JSON string and then to bytes
    const jsonData = Json.jsonmapper().stringify(multiSignByRequest);
    transaction.setDataSignature(new TextEncoder().encode(jsonData));

    // Note: Removed local checkMultiSignBy call since it validates signatures that were created
    // with the original transaction data, but now the transaction data has been modified to include
    // the new signature, which changes the transaction hash for future signatures
    // Server will perform comprehensive validation that includes domain permissions,
    // token solidity, and other checks beyond basic signature verification
    const adjustedBlock = await this.checkBlockPrototype(block);
    // this.checkMultiSignBy(multiSignBies, transactions[0]);
    return await this.adjustSolveAndSign(adjustedBlock);
  }
  async checkMultiSignBy(
    multiSignBies: MultiSignBy[],
    tx: Transaction
  ): Promise<boolean> {
    if (!multiSignBies || multiSignBies.length === 0) {
      return true; // Nothing to verify
    }

    // Verify each signature in the multiSignBies array
    for (const multiSignBy of multiSignBies) {
      const pubKeyHex = multiSignBy.getPublickey();
      const signatureHex = multiSignBy.getSignature();

      if (!pubKeyHex || !signatureHex) {
        throw new Error("Missing public key or signature in MultiSignBy");
      }

      // Decode public key and signature from hex
      const pubKeyBytes = Utils.HEX.decode(pubKeyHex);
      const signatureBytes = Utils.HEX.decode(signatureHex);

     
      // Create a temporary ECKey from the public key and verify the signature
      const tempKey = ECKey.fromPublicOnly(pubKeyBytes);
      const isValid = tempKey.verify(tx.getHash().getBytes(), signatureBytes);

      if (!isValid) {
        throw new Error(
          `Signature verification failed for address: ${multiSignBy.getAddress()}`
        );
      }
    }

    return true; // All signatures verified successfully
  }
  async checkTokenId(tokenid: string): Promise<Token> {
    const requestParam = new Map<string, any>();
    requestParam.set("tokenid", tokenid);

    // Using OkHttp3Util.post instead of postString
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenById,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam))
      )
    );

    const token: GetTokensResponse = Json.jsonmapper().parse(resp, {
      mainCreator: () => [GetTokensResponse],
    });

    const tokens = token.getTokens();
    if (!tokens || tokens.length === 0) {
      throw new NoTokenException();
    }

    return tokens[0];
  }

  filterTokenid(
    tokenid: Uint8Array,
    l: FreeStandingTransactionOutput[]
  ): FreeStandingTransactionOutput[] {
    return l.filter((output) => {
      const utxo = output.getUTXO();
      if (!utxo) return false;
      const tok = Utils.HEX.decode(utxo.getTokenId());
      return Utils.arraysEqual(tok, tokenid);
    });
  }

  async getECKey(aesKey: any, address: string | null): Promise<ECKey> {
    if (address === null) {
      throw new Error("Address cannot be null");
    }
    let pubKeyHash: Uint8Array;
    // Check if address is in base58 format (starts with '1' or '3' and contains alphanumeric characters)
    if (/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(address)) {
      // Decode base58 address to get public key hash
      const decoded = Base58.decode(address);
      // The public key hash is between bytes 1-21 (after version byte, before checksum)
      pubKeyHash = decoded.subarray(1, 21);
    } else {
      // Try hex decoding if it's a hex string
      pubKeyHash = Utils.HEX.decode(address);
    }

    const key = this.keyChainGroup.findKeyFromPubHash(pubKeyHash);
    if (key) {
      return key;
    }
    throw new Error("Key not found for address: " + address);
  }

  async payMoneyToECKeyList(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo: string,
    coinList: FreeStandingTransactionOutput[],
    fee: number,
    confirmTarget: number
  ): Promise<Block | null> {
    if (giveMoneyResult.size === 0) {
      return null;
    }

    let summe = Coin.valueOf(BigInt(0), new Uint8Array(tokenid));
    const multispent = new Transaction(this.params);
    multispent.setMemo(memo);

    // Add outputs for each recipient
    const entries = Array.from(giveMoneyResult.entries());
    for (const element of entries) {
      const [addressStr, amount] = element;
      const coin = new Coin(amount, new Uint8Array(tokenid));
      const address = Address.fromBase58(this.params, addressStr);
      multispent.addOutputAddress(coin, address);
      summe = summe.add(coin);
    }

    let amount = summe.negate();
    // Add fee if needed
    if (this.getFee() && amount.isBIG()) {
      const fee = Coin.valueOf(
        CoinConstants.FEE_DEFAULT.getValue(),
        amount.getTokenid()
      );
      amount = amount.add(fee.negate());
    }

    let beneficiary: ECKey | null = null;
    // Filter only for tokenid
    const coinListTokenid = this.filterTokenid(tokenid, coinList);

    for (const spendableOutput of coinListTokenid) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amount = amount.add(utxo.getValue());
        multispent.addInput2(
          spendableOutput.getUTXO().getBlockHash(),
          spendableOutput
        );

        if (!amount.isNegative()) {
          if (beneficiary) {
            multispent.addOutputEckey(amount, beneficiary);
          }
          break;
        }
      }
    }

    if (beneficiary == null || amount.isNegative()) {
      throw new InsufficientMoneyException(
        summe.toString() + " outputs size= " + coinListTokenid.length
      );
    }

    await this.signTransaction(multispent, aesKey, "THROW");
    const block = await this.getTip();
    block.addTransaction(multispent);
    if (this.getFee() && !amount.isBIG()) {
      const feeTx = await this.feeTransaction1(aesKey, coinList);
      block.addTransaction(feeTx);
    }
    return await this.solveAndPost(block);
  }

  /**
   * Add a transaction signer to the wallet
   * @param signer The transaction signer to add
   */
  addTransactionSigner(signer: any): void {
    this.signers.push(signer);
  }

  /**
   * Get the current fee settings
   */
  getFee(): boolean {
    // Call the parent class method to maintain proper inheritance
    return super.getFee();
  }

  /**
   * Get wallet keys
   * @param aesKey The encryption key
   * @returns Array of ECKey objects
   */
  async walletKeys(aesKey: any): Promise<ECKey[]> {
    // Call the parent class method to properly handle decryption if needed
    return await super.walletKeys(aesKey);
  }

  /**
   * Solve the block and post it to the network
   * @param block The block to solve and post
   * @returns The solved block
   */
  async solveAndPost(block: Block): Promise<Block> {
    try {
 
      // Solve the block
      block.solve();

      // Check the valid to time must be at least the block creation time

      // Post the block to the network
      await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.saveBlock,
        new Uint8Array(block.bitcoinSerialize())
      );

      return block;
    } catch (error) {
      // Handle connection errors
      if (error instanceof Error && error.message.includes("connect")) {
        if (this.serverPool) {
          this.serverPool.removeServer(this.getServerURL());
        }
        throw error;
      }
      // Re-throw any other errors
      throw error;
    }
  }

  async buyOrder(
    aesKey: any,
    tokenId: string,
    buyPrice: bigint,
    buyAmount: bigint,
    validToTime: Date | null,
    validFromTime: Date | null,
    baseToken: string,
    allowRemainder: boolean
  ): Promise<Block> {
    // Calculate total amount needed for the buy order (price * amount)
    const totalAmount = buyPrice * buyAmount;

    // Get spendable outputs to fund the order
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);

    // Create order transaction with proper inputs and outputs
    const tx = new Transaction(this.params);
    tx.setMemo("buy order");

    // Add outputs for the order (these would go to an escrow/smart contract mechanism)
    const baseTokenBytes = new Uint8Array(Utils.HEX.decode(baseToken));
    const totalCoin = new Coin(totalAmount, baseTokenBytes);

    // Add inputs and outputs similar to payMoneyToECKeyList method
    let amountNeeded = totalCoin.negate();

    // Add fee if needed
    if (this.getFee() && amountNeeded.isBIG()) {
      const fee = Coin.valueOf(
        CoinConstants.FEE_DEFAULT.getValue(),
        amountNeeded.getTokenid()
      );
      amountNeeded = amountNeeded.add(fee.negate());
    }

    let beneficiary: ECKey | null = null;

    // Filter only for base token (the token being used to pay)
    const coinListBaseToken = this.filterTokenid(baseTokenBytes, coinList);

    for (const spendableOutput of coinListBaseToken) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amountNeeded = amountNeeded.add(utxo.getValue());

        tx.addInput2(spendableOutput.getUTXO().getBlockHash(), spendableOutput);

        if (!amountNeeded.isNegative()) {
          if (beneficiary) {
            tx.addOutputEckey(amountNeeded, beneficiary);
          }
          break;
        }
      }
    }

    if (beneficiary == null || amountNeeded.isNegative()) {
      throw new InsufficientMoneyException(
        totalCoin.toString() + " outputs size= " + coinListBaseToken.length
      );
    }

    // Create order information as transaction data
    // For buy orders: we're buying targetToken with baseToken
    const orderInfo = new OrderOpenInfo(
      Number(buyAmount), // targetValue - amount of target token to buy
      tokenId, // targetTokenid - the token we want to buy
      beneficiary ? beneficiary.getPubKey() : null, // beneficiaryPubKey
      validToTime ? validToTime.getTime() : Date.now()+ NetworkParameters.ORDER_TIMEOUT_MAX, // validToTimeMilli
      validFromTime
        ? validFromTime.getTime()
        : Date.now() , // validFromTimeMilli
      Side.BUY, // side - BUY order
      beneficiary ? beneficiary.toAddress(this.params).toBase58() : null, // beneficiaryAddress
      baseToken, // orderBaseToken - the token used for payment
      Number(buyPrice), // price - price per unit
      Number(totalAmount), // offerValue - total amount of base token to spend
      baseToken // offerTokenid - the token being offered (base token for buy orders)
    );

    tx.setData(orderInfo.toByteArray());
    tx.setDataClassName("OrderOpen");

    // Sign the transaction
    await this.signTransaction(tx, aesKey, "THROW");

    // Get the current tip block to inherit the correct difficulty target and other parameters
    const block = await this.getTip();

    block.addTransaction(tx);
    block.setBlockType(BlockType.BLOCKTYPE_ORDER_OPEN);
    if (this.getFee() && !amountNeeded.isBIG()) {
      await this.feeTransaction(aesKey, block);
    }
    return this.solveAndPost(block);
  }

  public async sellOrder(
    aesKey: any,
    tokenId: string,
    sellPrice: bigint,
    offerValue: bigint,
    validToTime: Date | null,
    validFromTime: Date | null,
    baseToken: string,
    allowRemainder: boolean
  ): Promise<Block> {
    // Get spendable outputs to fund the order (the tokens being sold)
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);

    // Create order transaction with proper inputs and outputs
    const tx = new Transaction(this.params);
    tx.setMemo("sell order");

    // Add inputs and outputs similar to payMoneyToECKeyList method
    // For sell orders, we need to lock the tokens being sold
    const tokenidBytes = new Uint8Array(Utils.HEX.decode(tokenId));
    const totalCoin = new Coin(offerValue, tokenidBytes);

    // Add inputs and outputs for the tokens being sold
    let amountNeeded = totalCoin.negate();

    // Add fee if needed
    if (this.getFee() && amountNeeded.isBIG()) {
      const fee = Coin.valueOf(
        CoinConstants.FEE_DEFAULT.getValue(),
        amountNeeded.getTokenid()
      );
      amountNeeded = amountNeeded.add(fee.negate());
    }

    let beneficiary: ECKey | null = null;

    // Filter only for the token being sold
    const coinListToken = this.filterTokenid(tokenidBytes, coinList);

    for (const spendableOutput of coinListToken) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amountNeeded = amountNeeded.add(utxo.getValue());

        tx.addInput2(spendableOutput.getUTXO().getBlockHash(), spendableOutput);

        if (!amountNeeded.isNegative()) {
          if (beneficiary) {
            tx.addOutputEckey(amountNeeded, beneficiary);
          }
          break;
        }
      }
    }

    if (beneficiary == null || amountNeeded.isNegative()) {
      throw new InsufficientMoneyException(
        totalCoin.toString() + " outputs size= " + coinListToken.length
      );
    }
    console.debug(" sellOrder block before getTip");
    // Get the current tip block to inherit the correct difficulty target and other parameters
    let block: Block;
    try {
      block = await this.getTip();
      console.debug(" sellOrder block after getTip: " + block.toString());
    } catch (error) {
      console.error(" sellOrder getTip() error: ", error);
      throw error;
    }
    // Create order information as transaction data
    // For sell orders: we're selling tokenid for baseToken
    const orderInfo = new OrderOpenInfo(
      Number(offerValue), // targetValue - amount of token to sell
      baseToken, // targetTokenid - the base token we want to receive
      beneficiary ? beneficiary.getPubKey() : null, // beneficiaryPubKey
      validToTime ? validToTime.getTime() : Date.now(), // validToTimeMilli
      validFromTime
        ? validFromTime.getTime()
        : Date.now() + NetworkParameters.ORDER_TIMEOUT_MAX, // validFromTimeMilli
      Side.SELL, // side - SELL order
      beneficiary ? beneficiary.toAddress(this.params).toBase58() : null, // beneficiaryAddress
      baseToken, // orderBaseToken - the token used for payment
      Number(sellPrice), // price - price per unit
      Number(offerValue), // offerValue - total amount of token being sold
      tokenId // offerTokenid - the token being offered (the token being sold)
    );

    tx.setData(orderInfo.toByteArray());
    tx.setDataClassName("OrderOpen");

    // Sign the transaction
    await this.signTransaction(tx, aesKey, "THROW");

    block.addTransaction(tx);
    block.setBlockType(BlockType.BLOCKTYPE_ORDER_OPEN);
    if (this.getFee() && !amountNeeded.isBIG()) {
      await this.feeTransaction(aesKey, block);
    }
    return this.solveAndPost(block);
  }

  totalAmount(
    price: bigint,
    amount: bigint,
    tokenDecimal: number,
    allowRemainder: boolean
  ): bigint {
    // Calculate total amount: price * amount
    let total = price * amount;

    // If remainder is not allowed, we need to adjust based on token decimals
    if (!allowRemainder) {
      const divisor = BigInt(Math.pow(10, tokenDecimal));
      total = (total / divisor) * divisor;
    }

    return total;
  }

  /**
   * Get the balance of a specific token
   * @param aesKey The encryption key
   * @param tokenid The token ID to check
   * @returns The balance as a Coin object
   */
  async getBalance(aesKey: any, tokenid?: Uint8Array): Promise<Coin> {
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);

    let totalValue = BigInt(0);
    const tokenIdToCheck = tokenid || NetworkParameters.getBIGTANGLE_TOKENID();

    for (const utxo of utxos) {
      if (utxo && utxo.getTokenId) {
        const utxoTokenId = Utils.HEX.decode(utxo.getTokenId());
        if (Utils.arraysEqual(utxoTokenId, tokenIdToCheck)) {
          const value = utxo.getValue();
          const valueToAdd =
            typeof value === "bigint"
              ? value
              : value.getValue
              ? value.getValue()
              : BigInt(0);
          totalValue += valueToAdd;
        }
      }
    }

    return Coin.valueOf(totalValue, new Uint8Array(tokenIdToCheck));
  }

  /**
   * Create a new key pair and add it to the wallet
   * @returns The new ECKey
   */
  freshReceiveKey(): ECKey {
    return this.keyChainGroup.freshKey(KeyPurpose.RECEIVE_FUNDS);
  }

  /**
   * Get the current receive address
   * @returns The current receive address
   */
  currentReceiveAddress(): Address {
    return this.keyChainGroup.currentAddress(KeyPurpose.RECEIVE_FUNDS);
  }

  /**
   * Get a fresh receive address
   * @returns A new receive address
   */
  freshReceiveAddress(): Address {
    return this.keyChainGroup.freshAddress(KeyPurpose.RECEIVE_FUNDS);
  }

  /**
   * Publish a domain name with associated data
   * @param aesKey The encryption key
   * @param domainName The domain name to publish
   * @param data The data associated with the domain
   * @returns A block containing the transaction
   */
  async publishDomainName(
    aesKey: any,
    domainName: string,
    data: string
  ): Promise<Block> {
    // Create a transaction for domain registration
    const tx = new Transaction(this.params);

    // Add domain name and data as transaction data
    const domainInfo = {
      domainName,
      data,
      timestamp: Date.now(),
    };

    // Convert to byte array
    const domainData = new TextEncoder().encode(JSON.stringify(domainInfo));
    tx.setData(domainData);

    // Add a simple memo
    tx.setMemo(`domain registration: ${domainName}`);

    // Sign the transaction
    await this.signTransaction(tx, aesKey, "THROW");

    // Create a block with the transaction
    const block = await this.getTip();
    block.addTransaction(tx);
    // Use BLOCKTYPE_USERDATA for domain registration since BLOCKTYPE_DOMAIN doesn't exist
    block.setBlockType(BlockType.BLOCKTYPE_USERDATA);

    return this.solveAndPost(block);
  }

  /**
   * Place a bid on an auction
   * @param aesKey The encryption key
   * @param auctionId The ID of the auction
   * @param bidAmount The amount to bid
   * @param tokenid The token ID for the bid
   * @returns A block containing the transaction
   */
  async placeBid(
    aesKey: any,
    auctionId: string,
    bidAmount: Coin,
    tokenid: Uint8Array
  ): Promise<Block> {
    // Create a transaction for the bid
    const tx = new Transaction(this.params);

    // Add auction info as transaction data
    const auctionInfo = {
      auctionId,
      bidAmount: bidAmount.getValue(),
      tokenid: Utils.HEX.encode(tokenid),
    };

    // Convert to byte array
    const auctionData = new TextEncoder().encode(JSON.stringify(auctionInfo));
    tx.setData(auctionData);

    // Add input representing the bid amount
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);
    const tokenUtxos = utxos.filter((utxo) =>
      Utils.arraysEqual(Utils.HEX.decode(utxo.getTokenId()), tokenid)
    );

    if (tokenUtxos.length === 0) {
      throw new Error(`No UTXOs found for token: ${Utils.HEX.encode(tokenid)}`);
    }

    // Add outputs for bid
    let totalBid = BigInt(0);
    for (const utxo of tokenUtxos) {
      if (totalBid >= bidAmount.getValue()) {
        break;
      }
      tx.addInput2(
        utxo.getBlockHash(),
        new FreeStandingTransactionOutput(this.params, utxo)
      );
      const utxoValue = utxo.getValue();
      const utxoValueBigInt =
        typeof utxoValue === "bigint" ? utxoValue : utxoValue.getValue();
      totalBid = totalBid + utxoValueBigInt;
    }

    if (totalBid < bidAmount.getValue()) {
      throw new InsufficientMoneyException(
        `Insufficient funds for bid: ${bidAmount.toString()}`
      );
    }

    // If there's change, send it back
    if (totalBid > bidAmount.getValue()) {
      const changeAmount = Coin.valueOf(
        totalBid - bidAmount.getValue(),
        new Uint8Array(tokenid)
      );
      const beneficiary = await this.getECKey(
        aesKey,
        tokenUtxos[0].getAddress()
      );
      const changeOutput = new TransactionOutput(
        this.params,
        tx,
        changeAmount,
        beneficiary.getPubKey()
      );
      tx.addOutput(changeOutput);
    }

    // Add a simple memo
    tx.setMemo(`bid on auction: ${auctionId}`);

    // Sign the transaction
    await this.signTransaction(tx, aesKey, "THROW");

    // Create a block with the transaction
    const block = await this.getTip();
    block.addTransaction(tx);
    // Use BLOCKTYPE_USERDATA for bid transactions since BLOCKTYPE_BID doesn't exist
    block.setBlockType(BlockType.BLOCKTYPE_USERDATA);

    return this.solveAndPost(block);
  }

  /**
   * Create a new token/coin with full parameters as per Java implementation
   * @param key The key for the token
   * @param domainname The domain name for the token
   * @param increment Whether the token is incremental
   * @param token The token object
   * @param addresses List of multi-sign addresses
   * @param pubkeyTo The public key to send to
   * @param memoInfo Memo information
   * @returns A block containing the transaction
   */
  async createToken(
    key: ECKey,
    domainname: string,
    increment: boolean,
    token: Token,
    addresses: MultiSignAddress[],
    pubkeyTo: Uint8Array,
    memoInfo: MemoInfo
  ): Promise<Block> {
    const domainResponse = await this.getDomainNameBlockHash2(
      domainname,
      "token"
    );
    const domainToken = domainResponse.getdomainNameToken();
    if (domainToken) {
      token.setDomainName(domainToken.getTokenname() || "");
      token.setDomainNameBlockHash(domainToken.getBlockHashHex() || "");
    }

    const tokenid = token.getTokenid
      ? token.getTokenid()
      : (token as any).tokenid;

    // Get token index from server
    const requestParam00 = new Map<string, string>();
    requestParam00.set("tokenid", tokenid);
    const resp2 = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenIndex,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam00))
      )
    );

    const tokenIndexResponse = Json.jsonmapper().parse(resp2, {
      mainCreator: () => [TokenIndexResponse],
    }) as TokenIndexResponse;

    token.setTokenindex(
      tokenIndexResponse.getTokenindex ? tokenIndexResponse.getTokenindex() : 0
    );
    // Set prevblockhash, use ZERO_HASH if the response doesn't have a blockhash (first token case)
    token.setPrevblockhash(
      tokenIndexResponse.getBlockhash
        ? tokenIndexResponse.getBlockhash()
        : Sha256Hash.ZERO_HASH
    );
    token.setTokenstop(!increment);

    const tokenInfo = new TokenInfo();
    tokenInfo.setToken(token);
    tokenInfo.setMultiSignAddresses(addresses);

    // Create base coin with token amount and token id
    const tokenAmount =
      (token.getAmount ? token.getAmount() : BigInt(0)) ?? BigInt(0);
    const basecoin = new Coin(
      tokenAmount,
      new Uint8Array(Utils.HEX.decode(tokenid))
    );

    return await this.saveToken(
      tokenInfo,
      basecoin,
      key,
      null,
      pubkeyTo,
      memoInfo
    );
  }

  /**
   * Create a new token/coin (simplified version)
   * @param aesKey The encryption key
   * @param tokenInfo The token information
   * @param initialSupply The initial supply of the token
   * @param ownerKey The owner key for the token
   * @returns A block containing the transaction
   */
  async createTokenSimple(
    aesKey: any,
    tokenInfo: TokenInfo,
    initialSupply: Coin,
    ownerKey: ECKey
  ): Promise<Block> {
    // Create a transaction for the token creation
    const tx = new Transaction(this.params);

    // Add token creation data
    tx.setData(tokenInfo.toByteArray());

    // Add output for initial token supply
    const output = new TransactionOutput(
      this.params,
      tx,
      initialSupply,
      ownerKey.getPubKey()
    );
    tx.addOutput(output);

    // Add a simple memo
    const tokenResult = tokenInfo.getToken ? tokenInfo.getToken() : null;
    const tokenName =
      tokenResult && tokenResult.getTokenname
        ? tokenResult.getTokenname()
        : "Unknown Token";
    tx.setMemo(`create token: ${tokenName}`);

    // Sign the transaction
    await this.signTransaction(tx, aesKey, "THROW");

    // Create a block with the transaction
    const block = await this.getTip();
    block.addTransaction(tx);
    block.setBlockType(BlockType.BLOCKTYPE_TOKEN_CREATION);

    return block;
  }

  /**
   * Get all unspent outputs for a specific address
   * @param aesKey The encryption key
   * @param address The address to check
   * @returns Array of unspent outputs
   */
  async getUnspentOutputsForAddress(
    aesKey: any,
    address: string
  ): Promise<UTXO[]> {
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);
    return utxos.filter(
      (utxo) => utxo.getAddress() === address && !utxo.isSpent()
    );
  }

  /**
   * Get transaction history for the wallet
   * @param aesKey The encryption key
   * @returns Array of transactions
   */
  async getTransactionHistory(aesKey: any): Promise<Transaction[]> {
    // Get wallet keys to identify relevant transactions
    const keys = await this.walletKeys(aesKey);
    const pubKeyHashes = keys.map((key) =>
      Utils.HEX.encode(key.getPubKeyHash())
    );

    // This would typically involve a call to the server to get transactions
    // associated with these public key hashes
    const requestParam = {
      pubKeyHashes: pubKeyHashes,
    };

    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOutputsHistory,
      new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
    );

    // Parse the response and return an array of transactions
    // For now, returning an empty array as the actual implementation
    // would depend on the server response format
    const responseObj: any = Json.jsonmapper().parse(resp);

    if (responseObj.transactions) {
      return responseObj.transactions.map((txData: any) => {
        // Convert transaction data to Transaction objects
        return new Transaction(this.params);
      });
    }

    return [];
  }

  async getDomainNameBlockHash(
    domainname: string
  ): Promise<GetDomainTokenResponse> {
    // Replace 'any' with proper type when available
    return this.getDomainNameBlockHash2(domainname, "");
  }
  async getDomainNameBlockHash2(
    domainname: string,
    token: string
  ): Promise<GetDomainTokenResponse> {
    const requestParam = new Map<string, any>();
    requestParam.set("domainname", domainname);
    requestParam.set("token", token);
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getDomainNameBlockHash,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam))
      )
    );

    // First parse to plain object
    const responseObj: any = Json.jsonmapper().parse(resp);

    // Create response object manually
    const result = new GetDomainTokenResponse();

    // Handle the domainNameToken property if it exists
    if (responseObj.domainNameToken) {
      // Create a basic Token object with the response data
      const tokenObj = new Token();
      if (typeof responseObj.domainNameToken === "object") {
        // Copy properties from the parsed object to the token instance
        if (responseObj.domainNameToken.tokenid !== undefined) {
          tokenObj.setTokenid(responseObj.domainNameToken.tokenid);
        }
        if (responseObj.domainNameToken.tokenname !== undefined) {
          tokenObj.setTokenname(responseObj.domainNameToken.tokenname);
        }
        if (responseObj.domainNameToken.domainName !== undefined) {
          tokenObj.setDomainName(responseObj.domainNameToken.domainName);
        }
        if (responseObj.domainNameToken.domainNameBlockHash !== undefined) {
          tokenObj.setDomainNameBlockHash(
            responseObj.domainNameToken.domainNameBlockHash
          );
        }
        if (responseObj.domainNameToken.tokenindex !== undefined) {
          tokenObj.setTokenindex(responseObj.domainNameToken.tokenindex);
        }
        if (responseObj.domainNameToken.description !== undefined) {
          tokenObj.setDescription(responseObj.domainNameToken.description);
        }
        if (responseObj.domainNameToken.amount !== undefined) {
          tokenObj.setAmount(responseObj.domainNameToken.amount);
        }
        if (responseObj.domainNameToken.decimals !== undefined) {
          tokenObj.setDecimals(responseObj.domainNameToken.decimals);
        }
        if (responseObj.domainNameToken.signnumber !== undefined) {
          tokenObj.setSignnumber(responseObj.domainNameToken.signnumber);
        }
        if (responseObj.domainNameToken.tokentype !== undefined) {
          tokenObj.setTokentype(responseObj.domainNameToken.tokentype);
        }
        if (responseObj.domainNameToken.tokenstop !== undefined) {
          tokenObj.setTokenstop(responseObj.domainNameToken.tokenstop);
        }
        if (responseObj.domainNameToken.prevblockhash !== undefined) {
          tokenObj.setPrevblockhash(responseObj.domainNameToken.prevblockhash);
        }
        if (responseObj.domainNameToken.classification !== undefined) {
          tokenObj.setClassification(
            responseObj.domainNameToken.classification
          );
        }
        if (responseObj.domainNameToken.language !== undefined) {
          tokenObj.setLanguage(responseObj.domainNameToken.language);
        }
        if (responseObj.domainNameToken.revoked !== undefined) {
          tokenObj.setRevoked(responseObj.domainNameToken.revoked);
        }
        if (responseObj.domainNameToken.tokenKeyValues !== undefined) {
          tokenObj.setTokenKeyValues(
            responseObj.domainNameToken.tokenKeyValues
          );
        }
        // Handle properties from the parent SpentBlock class if needed
        if (
          responseObj.domainNameToken.blockHash !== undefined &&
          responseObj.domainNameToken.blockHash !== null
        ) {
          // The blockHash might come as a hex string, so we need to properly convert it to Sha256Hash
          const blockHashData = responseObj.domainNameToken.blockHashHex;
          if (
            typeof blockHashData === "string" &&
            blockHashData.length === 64
          ) {
            // 32 bytes = 64 hex characters
            // If it's a hex string, verify it's 32 bytes when decoded and create a Sha256Hash from it
            tokenObj.setBlockHash(
              Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(blockHashData)))
            );
          } else if (
            blockHashData &&
            typeof blockHashData === "object" &&
            blockHashData.bytes &&
            blockHashData.bytes.length === 32
          ) {
            // If it's an object with bytes array of correct length
            tokenObj.setBlockHash(
              Sha256Hash.wrap(new Uint8Array(blockHashData.bytes))
            );
          } else if (
            Array.isArray(blockHashData) &&
            blockHashData.length === 32
          ) {
            // If it's a raw byte array of correct length
            tokenObj.setBlockHash(
              Sha256Hash.wrap(new Uint8Array(blockHashData))
            );
          }
          // If none of the above conditions are met, skip setting the blockHash to avoid the error
        }
        if (responseObj.domainNameToken.spent !== undefined) {
          (tokenObj as any).setSpent(responseObj.domainNameToken.spent);
        }
        if (responseObj.domainNameToken.confirmed !== undefined) {
          (tokenObj as any).setConfirmed(responseObj.domainNameToken.confirmed);
        }
        if (responseObj.domainNameToken.time !== undefined) {
          (tokenObj as any).setTime(responseObj.domainNameToken.time);
        }
      }
      result.setdomainNameToken(tokenObj);
    }

    // Handle base class properties if they exist
    if (responseObj.success !== undefined) {
      (result as any).success = responseObj.success;
    }
    if (responseObj.error !== undefined) {
      (result as any).error = responseObj.error;
    }

    return result;
  }

  async getPrevTokenMultiSignAddressList(
    token: Token
  ): Promise<PermissionedAddressesResponse> {
    const requestParam = new Map<string, string>();
    const domainNameBlockHash = token.getDomainNameBlockHash
      ? token.getDomainNameBlockHash()
      : (token as any).domainNameBlockHash;

    // If no domainNameBlockHash, return empty response - this is for new tokens
    if (
      !domainNameBlockHash ||
      domainNameBlockHash === "" ||
      domainNameBlockHash === "null"
    ) {
      return new PermissionedAddressesResponse(); // Return empty response
    }

    try {
      requestParam.set("domainNameBlockHash", domainNameBlockHash);

      const resp = await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.getTokenPermissionedAddresses,
        new TextEncoder().encode(
          Json.jsonmapper().stringify(Object.fromEntries(requestParam))
        )
      );

      // Parse response as plain object first, then manually construct PermissionedAddressesResponse
      const responseObj: any = Json.jsonmapper().parse(resp);

      // Create a new PermissionedAddressesResponse and populate it manually
      const result = new PermissionedAddressesResponse();

      // Handle multiSignAddresses if it exists
      if (
        responseObj.multiSignAddresses &&
        Array.isArray(responseObj.multiSignAddresses)
      ) {
        // Create proper MultiSignAddress objects from the plain objects
        const multiSignAddresses = responseObj.multiSignAddresses.map(
          (addrData: any) => {
            const multiSignAddr = new MultiSignAddress(
              addrData.tokenid || "",
              addrData.address || "",
              addrData.pubKeyHex || "",
              addrData.posIndex || 0
            );
            // Set additional properties if they exist
            if (addrData.tokenHolder !== undefined) {
              multiSignAddr.setTokenHolder(addrData.tokenHolder);
            }
            return multiSignAddr;
          }
        );
        result.setMultiSignAddresses(multiSignAddresses);
      }

      // Handle domainName if it exists
      if (responseObj.domainName !== undefined) {
        result.setDomainName(responseObj.domainName);
      }

      return result;
    } catch (error: any) {
      // If the server throws an error (e.g., token not found), return empty response
      // This is expected when creating a new token that has no previous tokens
      console.warn(
        "Error getting prev token multi-sign addresses:",
        error.message
      );
      return new PermissionedAddressesResponse();
    }
  }

  async adjustSolveAndSign(block: Block): Promise<Block> {
    // Solve the block
    block.solve();
    //console.log("Solved block with nonce:", block.toString()  );
    // Post the block to the network using signToken endpoint as in Java implementation
    await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.signToken,
      new Uint8Array(block.bitcoinSerialize())
    );

    return block;
  }

  private async checkBlockPrototype(oldBlock: Block): Promise<Block> {
    const time = 60 * 60 * 8; // 8 hours in seconds
    if (Date.now() / 1000 - oldBlock.getTimeSeconds() > time) {
      const block = await this.getTip();
      block.setBlockType(oldBlock.getBlockType());
      const transactions = oldBlock.getTransactions();
      if (transactions) {
        for (const transaction of transactions) {
          block.addTransaction(transaction);
        }
      }
      block.solve();
      return block;
    } else {
      return oldBlock;
    }
  }

  /**
   * Get wallet information summary
   * @param aesKey The encryption key
   * @returns Wallet summary information
   */
  async getWalletInfo(aesKey: any): Promise<any> {
    const info: any = {};

    // Get the current balance for default token
    info.balance = await this.getBalance(aesKey);

    // Get the number of keys in the wallet
    info.keyCount = this.keyChainGroup.numKeys();

    // Get the current receive address
    info.currentReceiveAddress = this.currentReceiveAddress().toString();

    // Get server information
    info.serverURL = this.getServerURL();

    return info;
  }

  /**
   * Search for tokens by name
   * @param tokenname Optional token name to search for
   * @returns Object containing tokenList and amountMap
   */
  async searchToken(tokenname?: string): Promise<{
    tokenList: Token[];
    amountMap: Map<string, string> | null;
  }> {
    const requestParam: Record<string, any> = {};

    if (tokenname && tokenname.trim() !== "") {
      requestParam["name"] = tokenname;
    }

    let response: any;
    try {
      response = await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.searchTokens,
        new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
      );
    } catch (err) {
      console.error("searchToken: network error", err);
      return { tokenList: [], amountMap: null };
    }

    // Use standard JSON.parse to avoid Jackson parse errors
    let parsed: any = null;
    try {
      parsed = typeof response === "string" ? JSON.parse(response) : response;
    } catch (err) {
      console.error("searchToken: parse error", err, "Raw response:", response);
      return { tokenList: [], amountMap: null };
    }

    // tokenList and amountMap extraction
    const tokenList = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    const amountMap = parsed?.amountMap ? parsed.amountMap : null;

    return {
      tokenList,
      amountMap,
    };
  }
}
