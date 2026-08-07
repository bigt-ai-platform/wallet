import { Address } from "../core/Address";
import { Block } from "../core/Block";
import { Coin } from "../core/Coin";
import { CoinConstants } from "../core/CoinConstants";
import { PQKey } from "../crypto/pq/PQKey";
import { SignatureBundle } from "../crypto/pq/SignatureBundle";
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
import { NoDataException } from "../exception/NoDataException";
import { ReqCmd } from "../params/ReqCmd";
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
import { Script } from "../script/Script";
import { ScriptBuilder } from "../script/ScriptBuilder";
import { OrderCancelInfo } from "../core/OrderCancelInfo";
import { ContractEventCancelInfo } from "../core/ContractEventCancelInfo";
import { ContractEventInfo } from "../core/ContractEventInfo";
import { OutputsDetailsResponse } from "../response/OutputsDetailsResponse";
import { OrderTickerResponse } from "../response/OrderTickerResponse";
import { MatchLastdayResult } from "../ordermatch/MatchLastdayResult";
import { MonetaryFormat } from "../utils/MonetaryFormat";
import { KeyParameter } from "../crypto/KeyCrypter";
import { UserSettingDataInfo } from "../core/UserSettingDataInfo";

export class Wallet extends WalletBase {
  keyChainGroup: KeyChainGroup;
  url: string | null = null;

  static fromKeys(params: NetworkParameters, keys: PQKey[]): Wallet {
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
    keys: PQKey[],
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

  static fromKeysSingle(params: NetworkParameters, key: PQKey, url?: string): Wallet {
    if (key instanceof DeterministicKey) {
      throw new Error("DeterministicKey not allowed");
    }
    const keys: PQKey[] = [key];
    const group = new KeyChainGroup(params);
    group.importKeys(...keys);
    return url ? new Wallet(params, group, url) : new Wallet(params, group);
  }

  constructor(
    params: NetworkParameters,
    keyChainGroup?: KeyChainGroup,
    url?: string | null
  ) {
    super();
    this.params = params;
    this.keyChainGroup = keyChainGroup ?? new KeyChainGroup(params);
    if (params.getId && params.getId() === NetworkParameters.ID_UNITTESTNET) {
      this.keyChainGroup.lookaheadSize = 5;
    }
    if (this.keyChainGroup.numKeys() === 0) {
      this.keyChainGroup.createAndActivateNewHDChain();
    }
    this.signers = [];
    this.addTransactionSigner(new LocalTransactionSigner());
    if (!url) {
      this.serverURL = null;
    } else {
      this.url = url;
      this.setServerURL(url);
    }
  }

  /* =================================================================
   * UTXO / Spend Candidates
   * ================================================================= */

  checkSpendpending(output: UTXO): boolean {
    if (output.isSpendPending()) {
      return (Date.now() - output.getSpendPendingTime()) > WalletBase.SPENTPENDINGTIMEOUT;
    }
    return true;
  }

  async calculateAllSpendCandidatesUTXO(
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
    const jsonString = Json.jsonmapper().stringify(pubKeyHashs);
    const buffer = new TextEncoder().encode(jsonString);
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOutputs,
      buffer
    );
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
    utxos = utxos.filter(
      (utxo) => utxo && this.checkSpendpending(utxo)
    );
    if (!multisigns) {
      utxos = utxos.filter((utxo) => utxo && !utxo.isMultiSig());
    }
    utxos.sort(() => Math.random() - 0.5);
    return utxos;
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

  private sumOutputValues(outputs: FreeStandingTransactionOutput[]): bigint {
    let total = 0n;
    if (!outputs) return total;
    for (const output of outputs) {
      total += output.getValue().getValue();
    }
    return total;
  }

  private sumOutputs(tokenid: Uint8Array, outputs: FreeStandingTransactionOutput[]): Coin {
    let total = Coin.valueOf(0n, tokenid);
    if (!outputs) return total;
    for (const output of outputs) {
      total = output.getValue().add(total);
    }
    return total;
  }

  /* =================================================================
   * Token operations
   * ================================================================= */

  async checkTokenId(tokenid: string): Promise<Token> {
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenById,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(new Map([["tokenid", tokenid]])))
      )
    );
    const parsed = JSON.parse(resp);
    const tokenData = parsed?.tokens;
    if (!tokenData || tokenData.length === 0) {
      throw new NoTokenException();
    }
    const token = new Token();
    if (tokenData[0].tokenid != null) token.setTokenid(tokenData[0].tokenid);
    if (tokenData[0].tokenname != null) token.setTokenname(tokenData[0].tokenname);
    if (tokenData[0].description != null) token.setDescription(tokenData[0].description);
    if (tokenData[0].domainName != null) token.setDomainName(tokenData[0].domainName);
    if (tokenData[0].domainNameBlockHash != null) token.setDomainNameBlockHash(tokenData[0].domainNameBlockHash);
    if (tokenData[0].tokenindex != null) token.setTokenindex(tokenData[0].tokenindex);
    if (tokenData[0].tokentype != null) token.setTokentype(tokenData[0].tokentype);
    if (tokenData[0].tokenstop != null) token.setTokenstop(tokenData[0].tokenstop);
    if (tokenData[0].signnumber != null) token.setSignnumber(tokenData[0].signnumber);
    if (tokenData[0].decimals != null) token.setDecimals(tokenData[0].decimals);
    if (tokenData[0].revoked != null) token.setRevoked(tokenData[0].revoked);
    if (tokenData[0].classification != null) token.setClassification(tokenData[0].classification);
    if (tokenData[0].language != null) token.setLanguage(tokenData[0].language);
    if (tokenData[0].amount != null) token.setAmount(BigInt(tokenData[0].amount));
    if (tokenData[0].confirmed != null) token.setConfirmed(tokenData[0].confirmed);
    return token;
  }

  async saveToken(
    tokenInfo: TokenInfo,
    basecoin: Coin,
    ownerKey: PQKey,
    aesKey: any,
    pubKeyTo?: Uint8Array,
    memoInfo?: MemoInfo
  ): Promise<Block> {
    pubKeyTo ??= ownerKey.getPubKey();
    memoInfo ??= new MemoInfo("coinbase");

    const token = tokenInfo.getToken();

    if (Utils.isBlank(token.getDomainNameBlockHash()) && Utils.isBlank(token.getTokenname())) {
      const domainname = token.getTokenname();
      const getDomainBlockHashResponse = await this.getDomainNameBlockHash(domainname || "");
      const domainNameBlockHash = getDomainBlockHashResponse.getdomainNameToken();
      if (domainNameBlockHash) {
        token.setDomainNameBlockHash(domainNameBlockHash.getBlockHashHex() || "");
        token.setTokenname(domainNameBlockHash.getTokenname() || "");
      }
    }

    if (Utils.isBlank(token.getDomainNameBlockHash()) && !Utils.isBlank(token.getTokenname())) {
      const domain = (await this.getDomainNameBlockHash(token.getTokenname() || "")).getdomainNameToken();
      if (domain) {
        token.setDomainNameBlockHash(domain.getBlockHashHex() || "");
      }
    }

    const multiSignAddresses = tokenInfo.getMultiSignAddresses() || [];
    const permissionedAddressesResponse = await this.getPrevTokenMultiSignAddressList(token);

    if (
      permissionedAddressesResponse != null &&
      permissionedAddressesResponse.getMultiSignAddresses() != null &&
      permissionedAddressesResponse.getMultiSignAddresses()!.length > 0
    ) {
      if (Utils.isBlank(token.getTokenname())) {
        const newTokenName = permissionedAddressesResponse.getDomainName();
        if (newTokenName != null) {
          token.setTokenname(newTokenName);
        }
      }
      for (const multiSignAddress of permissionedAddressesResponse.getMultiSignAddresses()!) {
        const pubKeyHex = multiSignAddress.getPubKeyHex() || "";
        const tokenid = token.getTokenid() || "";
        multiSignAddresses.push(new MultiSignAddress(tokenid, "", pubKeyHex, 0));
      }
    }

    token.setSignnumber(token.getSignnumber() + 1);
    const block = await this.getTip();
    block.setBlockType(BlockType.BLOCKTYPE_TOKEN_CREATION);
    block.addCoinbaseTransaction(new Uint8Array(pubKeyTo), basecoin, tokenInfo, memoInfo);

    const transaction = block.getTransactions()![0];
    const sighash = transaction.getHash();
    const party1Signature = await ownerKey.signWithAesKey(sighash, aesKey);
    const buf1 = party1Signature.serialize();

    const multiSignBies: MultiSignBy[] = [];
    const multiSignBy0 = new MultiSignBy();
    const tokenIdStr = token.getTokenid() || "";
    multiSignBy0.setTokenid(tokenIdStr.trim());
    multiSignBy0.setTokenindex(0);
    multiSignBy0.setAddress(ownerKey.toAddress().toHex());
    multiSignBy0.setPublickey(Utils.HEX.encode(ownerKey.getPrefixedPublicKeyBytes()));
    multiSignBy0.setSignature(Utils.HEX.encode(buf1));
    multiSignBies.push(multiSignBy0);
    const multiSignByRequest = MultiSignByRequest.create(multiSignBies);
    transaction.setDataSignature(new TextEncoder().encode(Json.jsonmapper().stringify(multiSignByRequest)));

    if (this.getFee()) {
      block.addTransaction(await this.feeTransaction(aesKey));
    }
    return await this.adjustSolveAndSign(block);
  }

  async signToken(
    tokenid: string,
    signkey: PQKey,
    aesKey: any
  ): Promise<Block> {
    await this.checkTokenId(tokenid);
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
    outKey: PQKey,
    aesKey: any
  ): Promise<Block | null> {
    const requestParam = new Map<string, any>();
    const address = outKey.toAddress().toHex();
    requestParam.set("address", address);
    requestParam.set("tokenid", tokenid);

    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenSignByAddress,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam))
      )
    );

    const multiSignResponse: MultiSignResponse = Json.jsonmapper().parse(resp, {
      mainCreator: () => [MultiSignResponse, MultiSign],
    });

    const multiSignList = multiSignResponse.getMultiSigns();
    if (!multiSignList || multiSignList.length === 0) {
      return null;
    }
    const multiSign = multiSignList[0];

    let blockHashHex: string;
    if (typeof multiSign.getBlockhashHex === "function") {
      blockHashHex = multiSign.getBlockhashHex();
    } else {
      blockHashHex = (multiSign as any).blockhashHex || "";
    }

    const block = this.params
      .getDefaultSerializer()
      .makeBlock(new Uint8Array(Utils.HEX.decode(blockHashHex)));

    const transactions = block.getTransactions();
    if (!transactions || transactions.length === 0) {
      throw new Error("No transactions found in block");
    }
    const transaction = transactions[0];

    let multiSignBies: MultiSignBy[];
    if (transaction.getDataSignature() == null) {
      multiSignBies = [];
    } else {
      const multiSignByRequestData = transaction.getDataSignature();
      let dataStr: string;
      if (typeof multiSignByRequestData === "string") {
        dataStr = multiSignByRequestData;
      } else if (multiSignByRequestData instanceof Uint8Array) {
        dataStr = new TextDecoder().decode(multiSignByRequestData);
      } else {
        dataStr = String(multiSignByRequestData);
      }
      const multiSignByRequest: MultiSignByRequest = Json.jsonmapper().parse(
        dataStr,
        { mainCreator: () => [MultiSignByRequest, MultiSignBy] }
      );
      multiSignBies = multiSignByRequest.getMultiSignBies();
    }

    const sighash = transaction.getHash();
    const party1Signature = await outKey.signWithAesKey(sighash, aesKey);
    const buf1 = party1Signature.serialize();

    const multiSignBy0 = new MultiSignBy();
    let multiSignTokenId: string;
    let tokenindex: number;
    if (typeof multiSign.getTokenid === "function") {
      multiSignTokenId = multiSign.getTokenid();
      tokenindex = multiSign.getTokenindex();
    } else {
      multiSignTokenId = (multiSign as any).tokenid || "";
      tokenindex = (multiSign as any).tokenindex || 0;
    }

    multiSignBy0.setTokenid(multiSignTokenId);
    multiSignBy0.setTokenindex(tokenindex);
    multiSignBy0.setAddress(outKey.toAddress().toHex());
    multiSignBy0.setPublickey(Utils.HEX.encode(outKey.getPrefixedPublicKeyBytes()));
    multiSignBy0.setSignature(Utils.HEX.encode(buf1));

    multiSignBies.push(multiSignBy0);
    const multiSignByRequest = MultiSignByRequest.create(multiSignBies);
    transaction.setDataSignature(new TextEncoder().encode(Json.jsonmapper().stringify(multiSignByRequest)));

    const adjustedBlock = await this.checkBlockPrototype(block);
    return await this.adjustSolveAndSign(adjustedBlock);
  }

  async checkMultiSignBy(
    multiSignBies: MultiSignBy[],
    tx: Transaction
  ): Promise<boolean> {
    if (!multiSignBies || multiSignBies.length === 0) {
      return true;
    }
    for (const multiSignBy of multiSignBies) {
      const pubKeyHex = multiSignBy.getPublickey();
      const signatureHex = multiSignBy.getSignature();
      if (!pubKeyHex || !signatureHex) {
        throw new Error("Missing public key or signature in MultiSignBy");
      }
      const pubKeyBytes = Utils.HEX.decode(pubKeyHex);
      const signatureBytes = Utils.HEX.decode(signatureHex);
      const sigBundle = SignatureBundle.deserialize(signatureBytes);
      const isValid = PQKey.verify(tx.getHash(), sigBundle, pubKeyBytes);
      if (!isValid) {
        throw new Error(
          `Signature verification failed for address: ${multiSignBy.getAddress()}`
        );
      }
    }
    return true;
  }

  /* =================================================================
   * Payment methods
   * ================================================================= */

  async pay(
    aesKey: any,
    toAddress: string,
    coin: Coin,
    memoInfo?: MemoInfo
  ): Promise<Transaction | null> {
    const giveMoneyResult = new Map<string, bigint>();
    giveMoneyResult.set(toAddress, coin.getValue());
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.payMoneyToECKeyList(
      aesKey,
      giveMoneyResult,
      coin.getTokenid(),
      memoInfo ? memoInfo.toString() : "",
      coinList
    );
  }

  async payToList(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo?: string
  ): Promise<Transaction | null> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.payMoneyToECKeyList(
      aesKey,
      giveMoneyResult,
      tokenid,
      memo || "",
      coinList
    );
  }

  async payMoneyToECKeyList(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo: string,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<Transaction | null> {
    return this.payToListInternal(aesKey, giveMoneyResult, tokenid, memo, coinList);
  }

  private async payToListInternal(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo: string,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<Transaction | null> {
    if (giveMoneyResult.size === 0) {
      return null;
    }
    const tx = this.payToListTransaction(aesKey, giveMoneyResult, tokenid, memo, coinList);
    const [multispent, coinListTokenid] = await tx;
    await this.submitTransaction(multispent);
    if (this.getFee() && !Utils.arraysEqual(NetworkParameters.getBIGTANGLE_TOKENID(), tokenid)) {
      await this.submitTransaction(await this.feeTransaction(aesKey, coinList));
    }
    return multispent;
  }

  private async payToListTransaction(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo: string,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<[Transaction, FreeStandingTransactionOutput[]]> {
    let summe = Coin.valueOf(0n, tokenid);
    const multispent = new Transaction(this.params);
    multispent.setMemo(memo);
    for (const [addressStr, amount] of giveMoneyResult.entries()) {
      const a = new Coin(amount, tokenid);
      const address = Address.fromBase58(this.params, addressStr);
      multispent.addOutputAddress(a, address);
      summe = summe.add(a);
    }
    let amount = summe.negate();
    if (this.getFee() && amount.isBIG()) {
      amount = amount.add(CoinConstants.FEE_DEFAULT.negate());
    }
    let beneficiary: PQKey | null = null;
    const coinListTokenid = this.filterTokenid(tokenid, coinList);
    for (const spendableOutput of coinListTokenid) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amount = amount.add(utxo.getValue());
        multispent.addInput2(utxo.getBlockHash(), spendableOutput);
        if (!amount.isNegative()) {
          if (amount.isPositive()) {
            multispent.addOutputEckey(amount, beneficiary!);
          }
          break;
        }
      }
    }
    if (beneficiary == null || amount.isNegative()) {
      const deficit = amount.isNegative() ? amount.negate() : amount;
      const info = "payToList total=" + summe + " remainder=" + amount + " deficit=" + deficit
        + " recipients=" + giveMoneyResult.size;
      this.logInsufficientMoney("payToListTransaction", info, aesKey, coinListTokenid);
      throw new InsufficientMoneyException(summe + " outputs size= " + coinListTokenid.length);
    }
    await this.signTransaction(multispent, aesKey, "THROW");
    return [multispent, coinListTokenid];
  }

  /* =================================================================
   * payFromList - split payments across multiple transactions
   * ================================================================= */

  async payFromList(
    aesKey: any,
    destination: string,
    amount: Coin,
    memo: MemoInfo
  ): Promise<Transaction[]> {
    return this.payFromListSplit(aesKey, destination, amount, memo, await this.calculateAllSpendCandidates(aesKey, false));
  }

  async payFromListWithCandidates(
    aesKey: any,
    destination: string,
    amount: Coin,
    memo: MemoInfo,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<Transaction[]> {
    return this.payFromListSplit(aesKey, destination, amount, memo, coinList,
      Math.floor(NetworkParameters.MAX_DEFAULT_BLOCK_SIZE / 10000));
  }

  private async payFromListSplit(
    aesKey: any,
    destination: string,
    amount: Coin,
    memo: MemoInfo,
    coinList: FreeStandingTransactionOutput[],
    split: number = Math.floor(NetworkParameters.MAX_DEFAULT_BLOCK_SIZE / 10000)
  ): Promise<Transaction[]> {
    const coinTokenList = this.filterTokenid(amount.getTokenid(), coinList);
    const sum = this.sumOutputs(amount.getTokenid(), coinTokenList);
    if (sum.compareTo(amount) < 0) {
      const deficit = amount.subtract(sum);
      const info = "token=" + Utils.HEX.encode(amount.getTokenid()) + " required=" + amount + " available="
        + sum + " deficit=" + deficit + " destination=" + destination;
      this.logInsufficientMoney("payFromList", info, aesKey, coinTokenList);
      throw new InsufficientMoneyException("to pay " + amount + " account sum: " + sum);
    }
    const parts = this.chopped(coinTokenList, split);
    const re: Transaction[] = [];
    let payAmount = amount;
    for (const part of parts) {
      const canPay = this.sumOutputs(amount.getTokenid(), part);
      const tx = await this.payFromListNoSplitTransaction(aesKey, destination, payAmount, memo, part);
      re.push(tx);
      if (canPay.compareTo(payAmount) >= 0) {
        break;
      }
      payAmount = payAmount.subtract(canPay);
    }
    for (const tx of re) {
      await this.submitTransaction(tx);
      if (this.getFee() && !amount.isBIG()) {
        await this.submitTransaction(await this.feeTransaction(aesKey, coinList));
      }
    }
    return re;
  }

  private async payFromListNoSplitTransaction(
    aesKey: any,
    destination: string,
    amount: Coin,
    memo: MemoInfo,
    coinList: FreeStandingTransactionOutput[]
  ): Promise<Transaction> {
    const multispent = new Transaction(this.params);
    multispent.setMemo(memo.toJson());
    multispent.addOutputAddress(amount, Address.fromBase58(this.params, destination));
    let restAmount = amount.negate();
    let beneficiary: PQKey | null = null;
    if (this.getFee() && amount.isBIG()) {
      restAmount = restAmount.add(CoinConstants.FEE_DEFAULT.negate());
    }
    const coinTokenList = this.filterTokenid(restAmount.getTokenid(), coinList);
    for (const spendableOutput of coinTokenList) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        restAmount = spendableOutput.getValue().add(restAmount);
        multispent.addInput2(utxo.getBlockHash(), spendableOutput);
        if (!restAmount.isNegative()) {
          if (restAmount.isPositive()) {
            multispent.addOutputEckey(restAmount, beneficiary);
          }
          break;
        }
      }
    }
    if (beneficiary == null || restAmount.isNegative()) {
      const deficit = restAmount.isNegative() ? restAmount.negate() : restAmount;
      const info = "destination=" + destination + " requested=" + amount + " remaining=" + restAmount
        + " deficit=" + deficit + " inputs=" + coinTokenList.length;
      this.logInsufficientMoney("payFromListNoSplitTransaction", info, aesKey, coinTokenList);
      throw new InsufficientMoneyException(amount + " outputs size= " + coinTokenList.length);
    }
    await this.signTransaction(multispent, aesKey, "THROW");
    return multispent;
  }

  async payToScript(
    aesKey: any,
    amount: Coin,
    memo: MemoInfo | null,
    script: Script
  ): Promise<Transaction> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    const multispent = new Transaction(this.params);
    if (memo) multispent.setMemo(memo.toJson());
    multispent.addOutputScript(amount, script);
    let restAmount = amount.negate();
    let beneficiary: PQKey | null = null;
    if (this.getFee() && amount.isBIG()) {
      restAmount = restAmount.add(CoinConstants.FEE_DEFAULT.negate());
    }
    const coinTokenList = this.filterTokenid(restAmount.getTokenid(), coinList);
    for (const spendableOutput of coinTokenList) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        restAmount = restAmount.add(utxo.getValue());
        multispent.addInput2(utxo.getBlockHash(), spendableOutput);
        if (!restAmount.isNegative()) {
          if (restAmount.isPositive() && beneficiary) {
            multispent.addOutputEckey(restAmount, beneficiary);
          }
          break;
        }
      }
    }
    if (beneficiary == null || restAmount.isNegative()) {
      const deficit = restAmount.isNegative() ? restAmount.negate() : restAmount;
      const info = "scriptPayment requested=" + amount + " remaining=" + restAmount + " deficit=" + deficit
        + " memo=" + memo;
      this.logInsufficientMoney("payToScript", info, aesKey, coinTokenList);
      throw new InsufficientMoneyException(amount + " outputs size= " + coinTokenList.length);
    }
    await this.signTransaction(multispent, aesKey, "THROW");
    await this.submitTransaction(multispent);
    if (this.getFee() && !amount.isBIG()) {
      await this.submitTransaction(await this.feeTransaction(aesKey, coinList));
    }
    return multispent;
  }

  /* =================================================================
   * Fee transaction
   * ================================================================= */

  async feeTransactionOnly(aesKey: any): Promise<Transaction> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.feeTransaction(aesKey, coinList);
  }

  async feeTransaction(aesKey: any, coinList?: FreeStandingTransactionOutput[]): Promise<Transaction> {
    if (!coinList) {
      coinList = await this.calculateAllSpendCandidates(aesKey, false);
    }
    const spent = new Transaction(this.params);
    spent.setMemo("fee");
    let amount = CoinConstants.FEE_DEFAULT.negate();
    let beneficiary: PQKey | null = null;
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
          if (amount.isPositive()) {
            spent.addOutputEckey(amount, beneficiary);
          }
          break;
        }
      }
    }
    if (beneficiary == null || amount.isNegative()) {
      const deficit = amount.isNegative() ? amount.negate() : amount;
      const info = "feePayment required=" + CoinConstants.FEE_DEFAULT + " remainder=" + amount + " deficit=" + deficit;
      this.logInsufficientMoney("feeTransaction", info, aesKey, coinListTokenid);
      throw new InsufficientMoneyException(CoinConstants.FEE_DEFAULT + " outputs size= " + coinListTokenid.length);
    }
    await this.signTransaction(spent, aesKey, "THROW");
    return spent;
  }

  /* =================================================================
   * payPartsToOne - aggregate small coins
   * ================================================================= */

  async payPartsToOne(
    aesKey: any,
    destination: string,
    tokenid: Uint8Array,
    memo: string,
    low?: bigint
  ): Promise<Transaction | null> {
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);
    let summe = Coin.valueOf(0n, tokenid);
    let size = 0;
    const maxSize = Math.floor(NetworkParameters.MAX_DEFAULT_BLOCK_SIZE / 10000);
    for (const u of utxos) {
      const uTokenId = Utils.HEX.decode(u.getTokenId());
      if (Utils.arraysEqual(uTokenId, tokenid) && size < maxSize) {
        if (!low || low <= 0n || u.getValue().getValue() > low) {
          summe = summe.add(u.getValue());
          size += 1;
        }
      }
    }
    if (this.getFee() && Utils.arraysEqual(NetworkParameters.getBIGTANGLE_TOKENID(), tokenid)) {
      summe = summe.subtract(CoinConstants.FEE_DEFAULT);
    }
    return this.pay(aesKey, destination, summe, new MemoInfo(memo));
  }

  /* =================================================================
   * Order operations
   * ================================================================= */

  totalAmount(
    price: bigint,
    amount: bigint,
    tokenDecimal: number,
    allowRemainder: boolean
  ): bigint {
    const divisor = 10n ** BigInt(tokenDecimal);
    const re = price * amount / divisor;
    const remainder = (price * amount) % divisor;
    if (remainder > 0n && !allowRemainder) {
      throw new Error("Invalid price and quantity value with remainder " + remainder);
    }
    if (re < 1n || re > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Invalid target total value: " + re);
    }
    return re;
  }

  async buyOrder(
    aesKey: any,
    tokenId: string,
    buyPrice: bigint,
    targetValue: bigint,
    validToTime: number | null,
    validFromTime: number | null,
    orderBaseToken: string,
    allowRemainder: boolean
  ): Promise<Transaction> {
    const targetToken = await this.checkTokenId(tokenId);
    return this.buyOrderDo(aesKey, targetToken, buyPrice, targetValue, validToTime, validFromTime, orderBaseToken, allowRemainder);
  }

  async buyOrderDo(
    aesKey: any,
    targetToken: Token,
    buyPrice: bigint,
    targetValue: bigint,
    validToTime: number | null,
    validFromTime: number | null,
    orderBaseToken: string,
    allowRemainder: boolean
  ): Promise<Transaction> {
    if (targetToken.getTokenid() === orderBaseToken) {
      throw new Error("buy token is base token");
    }
    const priceshift = this.getOrderPriceShift(orderBaseToken);
    const candidates = await this.calculateAllSpendCandidates(aesKey, false);
    let toBePaid = new Coin(
      this.totalAmount(buyPrice, targetValue, targetToken.getDecimals() + priceshift, allowRemainder),
      new Uint8Array(Utils.HEX.decode(orderBaseToken))
    ).negate();
    if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING === orderBaseToken) {
      toBePaid = toBePaid.add(CoinConstants.FEE_DEFAULT.negate());
    }
    const tx = new Transaction(this.params);
    let beneficiary: PQKey | null = null;

    for (const spendableOutput of candidates) {
      if (orderBaseToken === spendableOutput.getUTXO().getTokenId()) {
        beneficiary = await this.getECKey(aesKey, spendableOutput.getUTXO().getAddress());
        toBePaid = spendableOutput.getValue().add(toBePaid);
        tx.addInput2(spendableOutput.getUTXO().getBlockHash(), spendableOutput);
        if (!toBePaid.isNegative()) {
          tx.addOutputEckey(toBePaid, beneficiary!);
          break;
        }
      }
    }
    if (beneficiary == null || toBePaid.isNegative()) {
      const baseTokenId = Utils.HEX.decode(orderBaseToken);
      const baseOutputs = this.filterTokenid(baseTokenId, candidates || []);
      const requiredAmount = toBePaid.negate();
      const availableCoin = this.sumOutputs(baseTokenId, baseOutputs);
      const deficitCoin = requiredAmount.subtract(availableCoin);
      const info = "orderBaseToken=" + orderBaseToken + " required=" + requiredAmount + " available="
        + availableCoin + " deficit=" + deficitCoin + " price=" + buyPrice + " targetValue=" + targetValue;
      this.logInsufficientMoney("buyOrderDo", info, aesKey, baseOutputs);
      throw new InsufficientMoneyException(orderBaseToken);
    }

    const info = new OrderOpenInfo(
      Number(targetValue),
      targetToken.getTokenid(),
      beneficiary.getPrefixedPublicKeyBytes(),
      validToTime,
      validFromTime,
      Side.BUY,
      beneficiary.toAddress().toHex(),
      orderBaseToken,
      Number(buyPrice),
      Number(this.totalAmount(buyPrice, targetValue, targetToken.getDecimals() + priceshift, allowRemainder)),
      orderBaseToken
    );
    tx.setData(info.toByteArray());
    tx.setDataClassName("OrderOpen");
    await this.signTransaction(tx, aesKey, "THROW");

    await this.submitTransaction(tx);
    if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING !== orderBaseToken) {
      await this.submitTransaction(await this.feeTransaction(aesKey, candidates));
    }
    return tx;
  }

  async sellOrder(
    aesKey: any,
    offerTokenId: string,
    sellPrice: bigint,
    offerValue: bigint,
    validToTime: number | null,
    validFromTime: number | null,
    orderBaseToken: string,
    allowRemainder: boolean
  ): Promise<Transaction> {
    const t = await this.checkTokenId(offerTokenId);
    return this.sellOrderDo(aesKey, t, sellPrice, offerValue, validToTime, validFromTime, orderBaseToken, allowRemainder);
  }

  async sellOrderDo(
    aesKey: any,
    t: Token,
    sellPrice: bigint,
    offerValue: bigint,
    validToTime: number | null,
    validFromTime: number | null,
    orderBaseToken: string,
    allowRemainder: boolean
  ): Promise<Transaction> {
    if (t.getTokenid() === orderBaseToken) {
      throw new Error("sell token is not allowed as base token");
    }
    const priceshift = this.getOrderPriceShift(orderBaseToken);
    const candidates = await this.calculateAllSpendCandidates(aesKey, false);
    let myCoin = Coin.valueOf(offerValue, new Uint8Array(Utils.HEX.decode(t.getTokenid()))).negate();
    if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING === t.getTokenid()) {
      myCoin = myCoin.add(CoinConstants.FEE_DEFAULT.negate());
    }
    const tx = new Transaction(this.params);
    let beneficiary: PQKey | null = null;

    for (const spendableOutput of candidates) {
      if (t.getTokenid() === spendableOutput.getUTXO().getTokenId()) {
        beneficiary = await this.getECKey(aesKey, spendableOutput.getUTXO().getAddress());
        myCoin = spendableOutput.getValue().add(myCoin);
        tx.addInput2(spendableOutput.getUTXO().getBlockHash(), spendableOutput);
        if (!myCoin.isNegative()) {
          tx.addOutputEckey(myCoin, beneficiary!);
          break;
        }
      }
    }
    if (beneficiary == null || myCoin.isNegative()) {
      const sellTokenBytes = Utils.HEX.decode(t.getTokenid());
      const sellOutputs = this.filterTokenid(sellTokenBytes, candidates || []);
      let requiredAmount = Coin.valueOf(offerValue, sellTokenBytes);
      if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING === t.getTokenid()) {
        requiredAmount = requiredAmount.add(CoinConstants.FEE_DEFAULT);
      }
      const availableCoin = this.sumOutputs(sellTokenBytes, sellOutputs);
      const deficitCoin = requiredAmount.subtract(availableCoin);
      const info = "sellToken=" + t.getTokenid() + " required=" + requiredAmount + " available="
        + availableCoin + " deficit=" + deficitCoin + " price=" + sellPrice + " offervalue=" + offerValue;
      this.logInsufficientMoney("sellOrderDo", info, aesKey, sellOutputs);
      throw new InsufficientMoneyException("");
    }

    const targetvalue = this.totalAmount(sellPrice, offerValue, t.getDecimals() + priceshift, allowRemainder);
    const info = new OrderOpenInfo(
      Number(targetvalue),
      orderBaseToken,
      beneficiary.getPrefixedPublicKeyBytes(),
      validToTime,
      validFromTime,
      Side.SELL,
      beneficiary.toAddress().toHex(),
      orderBaseToken,
      Number(sellPrice),
      Number(offerValue),
      t.getTokenid()
    );
    tx.setData(info.toByteArray());
    tx.setDataClassName("OrderOpen");
    await this.signTransaction(tx, aesKey, "THROW");

    await this.submitTransaction(tx);
    if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING !== t.getTokenid()) {
      await this.submitTransaction(await this.feeTransaction(aesKey, candidates));
    }
    return tx;
  }

  async cancelOrder(
    orderblockhash: Sha256Hash,
    aesKey: any,
    address: string
  ): Promise<Transaction> {
    let legitimatingKey: PQKey | null = null;
    const keys = await this.walletKeys(aesKey);
    for (const ecKey of keys) {
      if (address === ecKey.toAddress().toHex()) {
        legitimatingKey = ecKey;
        break;
      }
    }
    if (legitimatingKey == null) {
      throw new NoDataException("no keys");
    }
    const tx = new Transaction(this.params);
    const info = new OrderCancelInfo(orderblockhash);
    tx.setData(info.toByteArray());
    tx.setDataClassName("OrderCancelInfo");
    const sighash1 = tx.getHash();
    const party1Signature = await legitimatingKey.signWithAesKey(sighash1, null);
    tx.setDataSignature(party1Signature.serialize());
    await this.submitTransaction(tx);
    if (this.getFee()) {
      await this.submitTransaction(await this.feeTransaction(aesKey));
    }
    return tx;
  }

  async contractEventCancel(
    eventblockhash: Sha256Hash,
    aesKey: any,
    address: string
  ): Promise<Transaction> {
    let legitimatingKey: PQKey | null = null;
    const keys = await this.walletKeys(aesKey);
    for (const ecKey of keys) {
      if (address === ecKey.toAddress().toHex()) {
        legitimatingKey = ecKey;
        break;
      }
    }
    if (legitimatingKey == null) {
      throw new NoDataException("no keys");
    }
    const tx = new Transaction(this.params);
    const info = new ContractEventCancelInfo(eventblockhash);
    tx.setData(info.toByteArray());
    tx.setDataClassName("ContractEventCancelInfo");
    const sighash1 = tx.getHash();
    const party1Signature = await legitimatingKey.signWithAesKey(sighash1, null);
    tx.setDataSignature(party1Signature.serialize());
    await this.submitTransaction(tx);
    if (this.getFee()) {
      await this.submitTransaction(await this.feeTransaction(aesKey));
    }
    return tx;
  }

  async payContract(
    aesKey: any,
    tokenId: string,
    payAmount: bigint,
    validToTime: number | null,
    validFromTime: number | null,
    contractTokenid: string
  ): Promise<Transaction> {
    const amount = new Coin(payAmount, new Uint8Array(Utils.HEX.decode(tokenId))).negate();
    const tx = new Transaction(this.params);
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    let beneficiary: PQKey | null = null;
    for (const spendableOutput of this.filterTokenid(amount.getTokenid(), coinList)) {
      const utxo = spendableOutput.getUTXO();
      if (utxo) {
        beneficiary = await this.getECKey(aesKey, utxo.getAddress());
        amount.add(utxo.getValue());
        tx.addInput2(utxo.getBlockHash(), spendableOutput);
        if (!amount.isNegative()) {
          tx.addOutputEckey(amount, beneficiary!);
          break;
        }
      }
    }
    if (beneficiary == null || amount.isNegative()) {
      const deficit = amount.isNegative() ? amount.negate() : amount;
      const info = "payContract token=" + tokenId + " required=" + deficit + " remainder=" + amount
        + " outputs=" + coinList.length;
      this.logInsufficientMoney("payContract", info, aesKey, coinList);
      throw new InsufficientMoneyException(amount + " outputs size= " + coinList.length);
    }
    const info = new ContractEventInfo(
      contractTokenid,
      payAmount,
      tokenId,
      beneficiary.toAddress().toHex(),
      validToTime,
      validFromTime,
      ""
    );
    tx.setData(info.toByteArray());
    tx.setDataClassName("ContractEventInfo");
    await this.signTransaction(tx, aesKey, "THROW");
    await this.submitTransaction(tx);
    if (this.getFee() && NetworkParameters.BIGTANGLE_TOKENID_STRING !== tokenId) {
      await this.submitTransaction(await this.feeTransaction(aesKey, coinList));
    }
    return tx;
  }

  /* =================================================================
   * Transaction submission
   * ================================================================= */

  async submitTransaction(tx: Transaction): Promise<void> {
    try {
      await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.submitTransaction,
        new Uint8Array(tx.bitcoinSerialize())
      );
    } catch (error: any) {
      if (error.message && error.message.includes("connect")) {
        if (this.serverURL) {
          this.serverURL = null;
        }
      }
      throw error;
    }
  }

  payTransaction(txs: Transaction[]): Transaction | null {
    for (const tx of txs) {
      this.submitTransaction(tx);
    }
    return txs.length > 0 ? txs[0] : null;
  }

  retryBlocks(oldBlock: Block): Transaction | null {
    const txs = oldBlock.getTransactions();
    if (!txs || txs.length === 0) return null;
    for (const tx of txs) {
      this.submitTransaction(tx);
    }
    return txs[0];
  }

  async retryBlock(hashHex: string): Promise<Transaction | null> {
    const block = await this.getBlock(hashHex);
    return this.retryBlocks(block);
  }

  async rePayBlock(aesKey: any, hashHex: string): Promise<Transaction | null> {
    return this.retryBlock(hashHex);
  }

  /* =================================================================
   * Subtangle / Cross-chain
   * ================================================================= */

  async paySubtangle(
    aesKey: any,
    outputStr: string,
    connectKey: PQKey,
    toAddressInSubtangle: Address,
    coin: Coin,
    address: Address
  ): Promise<Transaction> {
    const requestParam: Record<string, any> = { hexStr: outputStr };
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOutputByKey,
      new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
    );
    const outputsDetailsResponse: OutputsDetailsResponse = Json.jsonmapper().parse(resp, {
      mainCreator: () => [OutputsDetailsResponse, UTXO],
    });
    const findOutput = outputsDetailsResponse.getOutputs();
    if (!findOutput) throw new Error("Output not found");
    const spendableOutput = new FreeStandingTransactionOutput(this.params, findOutput);
    const transaction = new Transaction(this.params);
    transaction.addOutputAddress(coin, address);
    transaction.setToAddressInSubtangle(toAddressInSubtangle.getHash160());
    const input = transaction.addInput2(findOutput.getBlockHash(), spendableOutput);
    const sighash = transaction.hashForSignature(0, spendableOutput.getScriptBytes(), 1 as any, false);
    const sigBundle = await connectKey.signWithAesKey(sighash, aesKey);
    const inputScript = new ScriptBuilder().data(sigBundle.serialize()).build();
    input.setScriptSig(inputScript);
    await this.submitTransaction(transaction);
    return transaction;
  }

  /* =================================================================
   * Signing / Keys
   * ================================================================= */

  async getECKey(aesKey: any, address: string | null): Promise<PQKey> {
    if (address === null) {
      throw new Error("Address cannot be null");
    }
    const keys = await this.walletKeys(aesKey);
    for (const ecKey of keys) {
      if (address === Address.fromKey(this.params, ecKey).toBase58()) {
        return ecKey;
      }
    }
    throw new Error("no key in wallet is found for this address " + address);
  }

  /* =================================================================
   * User data
   * ================================================================= */

  async saveUserdata(
    userKey: PQKey,
    transaction: Transaction,
    encrypt: boolean,
    aesKey: any
  ): Promise<Transaction> {
    const party1Signature = await userKey.signWithAesKey(transaction.getHash(), aesKey);
    const buf1 = party1Signature.serialize();
    const multiSignBies: MultiSignBy[] = [];
    const multiSignBy0 = new MultiSignBy();
    multiSignBy0.setAddress(userKey.toAddress().toHex());
    multiSignBy0.setPublickey(Utils.HEX.encode(userKey.getPubKey()));
    multiSignBy0.setSignature(Utils.HEX.encode(buf1));
    multiSignBies.push(multiSignBy0);
    transaction.setDataSignature(
      new TextEncoder().encode(Json.jsonmapper().stringify(multiSignBies))
    );
    await this.submitTransaction(transaction);
    if (this.getFee()) {
      await this.submitTransaction(await this.feeTransaction(aesKey));
    }
    return transaction;
  }

  async getUserSettingDataInfo(
    userKey: PQKey,
    encrypt: boolean
  ): Promise<any> {
    const requestParam: Record<string, string> = {
      dataclassname: "UserSettingDataInfo",
      pubKey: Utils.HEX.encode(userKey.getPubKey()),
    };
    const hexData = await OkHttp3Util.postAndGetBlock(
      this.getServerURL() + ReqCmd.getUserData,
      Json.jsonmapper().stringify(requestParam)
    );
    if (!hexData || hexData.length === 0) return null;
    const buf = Utils.HEX.decode(hexData);
    const payload = buf;
    const parsed = new UserSettingDataInfo().parse(payload);
    return parsed;
  }

  /* =================================================================
   * Domain name operations
   * ================================================================= */

  async publishDomainName(
    ownerKey: PQKey,
    tokenid: string,
    tokenname: string,
    aesKey: any,
    description: string
  ): Promise<void> {
    const getDomainBlockHashResponse = await this.getDomainNameBlockHash(tokenname);
    const domainName = getDomainBlockHashResponse.getdomainNameToken();
    const walletKeysList: PQKey[] = [ownerKey];
    const signnumber = walletKeysList.length;
    await this.publishDomainNameInternal(walletKeysList, ownerKey, tokenid, tokenname, domainName, aesKey, description, signnumber);
  }

  async publishDomainNameMulti(
    signKeys: PQKey[],
    ownerKey: PQKey,
    tokenid: string,
    tokenname: string,
    aesKey: any,
    description: string
  ): Promise<void> {
    const getDomainBlockHashResponse = await this.getDomainNameBlockHash(tokenname);
    const domainNameBlockHash = getDomainBlockHashResponse.getdomainNameToken();
    const signnumber = signKeys.length;
    await this.publishDomainNameInternal(signKeys, ownerKey, tokenid, tokenname, domainNameBlockHash, aesKey, description, signnumber);
  }

  private async publishDomainNameInternal(
    multiSigns: PQKey[],
    ownerKey: PQKey,
    tokenid: string,
    tokenname: string,
    domainNameBlockHash: Token | null,
    aesKey: any,
    description: string,
    signnumber: number
  ): Promise<void> {
    const tokenIndexResponse = await this.getServerCalTokenIndex(tokenid);
    const tokenindex_ = tokenIndexResponse.getTokenindex();
    const tokens = Token.buildDomainnameTokenInfo(
      true,
      tokenIndexResponse.getBlockhash() || Sha256Hash.ZERO_HASH,
      tokenid,
      tokenname,
      description,
      signnumber,
      tokenindex_,
      false,
      domainNameBlockHash ? domainNameBlockHash.getTokenname() || "" : "",
      domainNameBlockHash ? domainNameBlockHash.getBlockHashHex() || "" : ""
    );
    const tokenInfo = new TokenInfo();
    tokenInfo.setToken(tokens);
    const multiSignAddresses: MultiSignAddress[] = [];
    tokenInfo.setMultiSignAddresses(multiSignAddresses);
    for (const ecKey of multiSigns) {
      multiSignAddresses.push(new MultiSignAddress(tokenid, "", ecKey.getPublicKeyAsHex()));
    }
    await this.saveToken(
      tokenInfo,
      Coin.valueOf(1n, new Uint8Array(Utils.HEX.decode(tokenid))),
      ownerKey,
      aesKey,
      ownerKey.getPubKey(),
      new MemoInfo("publishDomainName")
    );
  }

  /* =================================================================
   * Token creation
   * ================================================================= */

  async createToken(
    key: PQKey,
    domainname: string,
    increment: boolean,
    token: Token,
    addresses: MultiSignAddress[],
    pubkeyTo: Uint8Array,
    memoInfo: MemoInfo
  ): Promise<Block> {
    const domainResponse = await this.getDomainNameBlockHash2(domainname, "token");
    const domainToken = domainResponse.getdomainNameToken();
    if (domainToken) {
      token.setDomainName(domainToken.getTokenname() || "");
      token.setDomainNameBlockHash(domainToken.getBlockHashHex() || "");
    }

    const tokenid = token.getTokenid();
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

    token.setTokenindex(tokenIndexResponse.getTokenindex() || 0);
    token.setPrevblockhash(
      tokenIndexResponse.getBlockhash() || Sha256Hash.ZERO_HASH
    );
    token.setTokenstop(!increment);

    const tokenInfo = new TokenInfo();
    tokenInfo.setToken(token);
    tokenInfo.setMultiSignAddresses(addresses);

    const tokenAmount = token.getAmount() ?? 0n;
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

  /* =================================================================
   * Server queries
   * ================================================================= */

  async getBlock(hashHex: string): Promise<Block> {
    const requestParam: Record<string, string> = { hashHex };
    const hexData = await OkHttp3Util.postAndGetBlock(
      this.getServerURL() + ReqCmd.getBlockByHash,
      Json.jsonmapper().stringify(requestParam)
    );
    const bytes = Utils.HEX.decode(hexData);
    const buffer = new Uint8Array(bytes);
    return this.params.getDefaultSerializer().makeBlock(buffer);
  }

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

  async getLastPrice(tokenid: string, basetoken: string): Promise<number> {
    const tokenids: string[] = [tokenid];
    const requestParam: Record<string, any> = {
      tokenids,
      count: 1,
      basetoken,
    };
    const response0 = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOrdersTicker,
      new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
    );
    const orderTickerResponse: OrderTickerResponse = Json.jsonmapper().parse(response0, {
      mainCreator: () => [OrderTickerResponse, MatchLastdayResult],
    });
    const tickers = orderTickerResponse.getTickers();
    if (tickers && tickers.length > 0) {
      const matchResult = tickers[0];
      const tokennames = orderTickerResponse.getTokennames();
      const base = tokennames ? tokennames.get(matchResult.getBasetokenid()) : undefined;
      const priceshift = base ? this.getOrderPriceShift(matchResult.getBasetokenid()) : 0;
      const price = MonetaryFormat.FIAT.formatValue(
        BigInt(matchResult.getPrice()),
        (base ? base.getDecimals() : 0) + priceshift
      );
      return parseFloat(price);
    }
    throw new NoDataException("tokenid=" + tokenid + " basetoken=" + basetoken);
  }

  getOrderPriceShift(orderBaseTokens: string): number {
    if (NetworkParameters.BIGTANGLE_TOKENID_STRING === orderBaseTokens) {
      return 0;
    }
    return 6;
  }

  async getDomainNameBlockHash(domainname: string): Promise<GetDomainTokenResponse> {
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
    const responseObj: any = Json.jsonmapper().parse(resp);
    const result = new GetDomainTokenResponse();
    if (responseObj.domainNameToken) {
      const tokenObj = new Token();
      if (typeof responseObj.domainNameToken === "object") {
        const d = responseObj.domainNameToken;
        if (d.tokenid !== undefined) tokenObj.setTokenid(d.tokenid);
        if (d.tokenname !== undefined) tokenObj.setTokenname(d.tokenname);
        if (d.domainName !== undefined) tokenObj.setDomainName(d.domainName);
        if (d.domainNameBlockHash !== undefined) tokenObj.setDomainNameBlockHash(d.domainNameBlockHash);
        if (d.tokenindex !== undefined) tokenObj.setTokenindex(d.tokenindex);
        if (d.description !== undefined) tokenObj.setDescription(d.description);
        if (d.amount !== undefined) tokenObj.setAmount(d.amount);
        if (d.decimals !== undefined) tokenObj.setDecimals(d.decimals);
        if (d.signnumber !== undefined) tokenObj.setSignnumber(d.signnumber);
        if (d.tokentype !== undefined) tokenObj.setTokentype(d.tokentype);
        if (d.tokenstop !== undefined) tokenObj.setTokenstop(d.tokenstop);
        if (d.prevblockhash !== undefined) tokenObj.setPrevblockhash(d.prevblockhash);
        if (d.classification !== undefined) tokenObj.setClassification(d.classification);
        if (d.language !== undefined) tokenObj.setLanguage(d.language);
        if (d.revoked !== undefined) tokenObj.setRevoked(d.revoked);
        if (d.tokenKeyValues !== undefined) tokenObj.setTokenKeyValues(d.tokenKeyValues);
        if (d.blockHashHex && typeof d.blockHashHex === "string" && d.blockHashHex.length === 64) {
          tokenObj.setBlockHash(Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(d.blockHashHex))));
        }
      }
      result.setdomainNameToken(tokenObj);
    }
    return result;
  }

  async getPrevTokenMultiSignAddressList(
    token: Token
  ): Promise<PermissionedAddressesResponse> {
    const requestParam = new Map<string, string>();
    const domainNameBlockHash = token.getDomainNameBlockHash();
    if (!domainNameBlockHash || domainNameBlockHash === "" || domainNameBlockHash === "null") {
      return new PermissionedAddressesResponse();
    }
    try {
      requestParam.set("domainNameBlockHash", domainNameBlockHash);
      const resp = await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.getTokenPermissionedAddresses,
        new TextEncoder().encode(
          Json.jsonmapper().stringify(Object.fromEntries(requestParam))
        )
      );
      const responseObj: any = Json.jsonmapper().parse(resp);
      const result = new PermissionedAddressesResponse();
      if (responseObj.multiSignAddresses && Array.isArray(responseObj.multiSignAddresses)) {
        const multiSignAddresses = responseObj.multiSignAddresses.map(
          (addrData: any) => {
            const multiSignAddr = new MultiSignAddress(
              addrData.tokenid || "",
              addrData.address || "",
              addrData.pubKeyHex || "",
              addrData.posIndex || 0
            );
            if (addrData.tokenHolder !== undefined) {
              multiSignAddr.setTokenHolder(addrData.tokenHolder);
            }
            return multiSignAddr;
          }
        );
        result.setMultiSignAddresses(multiSignAddresses);
      }
      if (responseObj.domainName !== undefined) {
        result.setDomainName(responseObj.domainName);
      }
      return result;
    } catch (error: any) {
      console.warn("Error getting prev token multi-sign addresses:", error.message);
      return new PermissionedAddressesResponse();
    }
  }

  async getServerCalTokenIndex(tokenid: string): Promise<TokenIndexResponse> {
    const requestParam = new Map<string, string>();
    requestParam.set("tokenid", tokenid);
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getTokenIndex,
      new TextEncoder().encode(
        Json.jsonmapper().stringify(Object.fromEntries(requestParam))
      )
    );
    return Json.jsonmapper().parse(resp, {
      mainCreator: () => [TokenIndexResponse],
    }) as TokenIndexResponse;
  }

  /* =================================================================
   * Block solving / posting
   * ================================================================= */

  private setRandomNonce(block: Block): void {
    block.setNonce(Math.floor(Math.random() * 0xFFFFFFFF));
  }

  async solveAndPost(block: Block): Promise<Block> {
    try {
      this.setRandomNonce(block);
      await OkHttp3Util.post(
        this.getServerURL() + ReqCmd.saveBlock,
        new Uint8Array(block.bitcoinSerialize())
      );
      return block;
    } catch (error) {
      if (error instanceof Error && error.message.includes("connect")) {
        if (this.serverURL) {
          this.serverURL = null;
        }
        throw error;
      }
      throw error;
    }
  }

  async adjustSolveAndSign(block: Block): Promise<Block> {
    // Note: do NOT set a random nonce here — the block hash must remain
    // stable so the server can match it to pending multisign records.
    await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.signToken,
      new Uint8Array(block.bitcoinSerialize())
    );
    return block;
  }

  private async checkBlockPrototype(oldBlock: Block): Promise<Block> {
    const time = 60 * 60 * 8;
    if (Math.floor(Date.now() / 1000) - oldBlock.getTimeSeconds() > time) {
      const block = await this.getTip();
      block.setBlockType(oldBlock.getBlockType());
      const transactions = oldBlock.getTransactions();
      if (transactions) {
        for (const transaction of transactions) {
          block.addTransaction(transaction);
        }
      }
      return block;
    } else {
      return oldBlock;
    }
  }

  /* =================================================================
   * Utility methods
   * ================================================================= */

  calc(m: number, factor: number, d: number): number {
    return Math.floor(m * factor / d);
  }

  chopped<T>(list: T[], L: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < list.length; i += L) {
      chunks.push(list.slice(i, i + L));
    }
    return chunks;
  }

  freshReceiveKey(): PQKey {
    return this.keyChainGroup.freshKey(KeyPurpose.RECEIVE_FUNDS);
  }

  currentReceiveAddress(): Address {
    return this.keyChainGroup.currentAddress(KeyPurpose.RECEIVE_FUNDS);
  }

  freshReceiveAddress(): Address {
    return this.keyChainGroup.freshAddress(KeyPurpose.RECEIVE_FUNDS);
  }

  async getBalance(aesKey: any, tokenid?: Uint8Array): Promise<Coin> {
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);
    let totalValue = 0n;
    const tokenIdToCheck = tokenid || NetworkParameters.getBIGTANGLE_TOKENID();
    for (const utxo of utxos) {
      if (utxo && utxo.getTokenId) {
        const utxoTokenId = Utils.HEX.decode(utxo.getTokenId());
        if (Utils.arraysEqual(utxoTokenId, tokenIdToCheck)) {
          totalValue += utxo.getValue().getValue();
        }
      }
    }
    return Coin.valueOf(totalValue, new Uint8Array(tokenIdToCheck));
  }

  async getWalletInfo(aesKey: any): Promise<any> {
    const info: any = {};
    info.balance = await this.getBalance(aesKey);
    info.keyCount = this.keyChainGroup.numKeys();
    info.currentReceiveAddress = this.currentReceiveAddress().toString();
    info.serverURL = this.getServerURL();
    return info;
  }

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
    let parsed: any = null;
    try {
      parsed = typeof response === "string" ? JSON.parse(response) : response;
    } catch (err) {
      console.error("searchToken: parse error", err, "Raw response:", response);
      return { tokenList: [], amountMap: null };
    }
    const tokenList = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    const amountMap = parsed?.amountMap ? parsed.amountMap : null;
    return { tokenList, amountMap };
  }

  async getTransactionHistory(aesKey: any): Promise<Transaction[]> {
    const keys = await this.walletKeys(aesKey);
    const pubKeyHashes = keys.map((key) =>
      Utils.HEX.encode(key.getPubKeyHash())
    );
    const requestParam = { pubKeyHashes };
    const resp = await OkHttp3Util.post(
      this.getServerURL() + ReqCmd.getOutputsHistory,
      new TextEncoder().encode(Json.jsonmapper().stringify(requestParam))
    );
    const responseObj: any = Json.jsonmapper().parse(resp);
    if (responseObj.transactions) {
      return responseObj.transactions.map((txData: any) => {
        return new Transaction(this.params);
      });
    }
    return [];
  }

  async getUnspentOutputsForAddress(
    aesKey: any,
    address: string
  ): Promise<UTXO[]> {
    const utxos = await this.calculateAllSpendCandidatesUTXO(aesKey, false);
    return utxos.filter(
      (utxo) => utxo.getAddress() === address && !utxo.isSpent()
    );
  }

  /* =================================================================
   * Deprecated wrappers for backward compatibility
   * ================================================================= */

  async payToListCandidates(
    aesKey: any,
    giveMoneyResult: Map<string, bigint>,
    tokenid: Uint8Array,
    memo: string
  ): Promise<Transaction | null> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.payMoneyToECKeyList(aesKey, giveMoneyResult, tokenid, memo, coinList);
  }

  async createTransaction(
    aesKey: any,
    destination: string,
    amount: Coin,
    memo: MemoInfo
  ): Promise<Transaction> {
    const coinList = await this.calculateAllSpendCandidates(aesKey, false);
    return this.payFromListNoSplitTransaction(aesKey, destination, amount, memo, coinList);
  }

  async createTransactionWithCandidates(
    aesKey: any,
    candidates: FreeStandingTransactionOutput[],
    destination: string,
    amount: Coin,
    memo: string
  ): Promise<Transaction> {
    return this.payFromListNoSplitTransaction(aesKey, destination, amount, new MemoInfo(memo), candidates);
  }

  /* =================================================================
   * Private logging helpers
   * ================================================================= */

  private logInsufficientMoney(
    context: string,
    deficitInfo: string,
    aesKey: any,
    outputs: FreeStandingTransactionOutput[]
  ): void {
    console.info(`[${context}] insufficient money -> ${deficitInfo}`);
    this.logOutputDetails(outputs);
    this.logWalletKeys(aesKey);
  }

  private logOutputDetails(outputs: FreeStandingTransactionOutput[]): void {
    if (!outputs) {
      console.info("Spendable outputs snapshot unavailable");
      return;
    }
    console.info("Spendable outputs count: " + outputs.length);
    for (const output of outputs) {
      const utxo = output.getUTXO();
      if (utxo) {
        console.info("Output summary -> blockHash:" + utxo.getBlockHash() + " value:" + output.getValue() + " token:" + utxo.getTokenId() + " address:" + utxo.getAddress());
      }
    }
  }

  private logWalletKeys(aesKey: any): void {
    try {
      this.walletKeys(aesKey).then((keys) => {
        if (!keys || keys.length === 0) {
          console.info("Wallet keys unavailable (no keys returned)");
          return;
        }
        for (const ecKey of keys) {
          console.info("Wallet key: " + ecKey.toAddress().toHex());
        }
      }).catch((e: Error) => {
        console.info("Wallet keys unavailable (" + e.message + ")");
      });
    } catch (e: any) {
      console.info("Wallet keys unavailable (" + e.message + ")");
    }
  }
}
