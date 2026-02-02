/**
 * Type definitions for bigtangle-ts package
 * This is a minimal type definition to resolve TypeScript errors
 */

declare module 'bigtangle-ts' {
  export interface ECKey {
    publicKey: Uint8Array;
    privateKey?: Uint8Array;
    compressed: boolean;
    fromPrivate(bytes: Uint8Array): ECKey;
  }

  export interface Address {
    scriptHash: string;
    toString(): string;
    fromBase58(params: any, address: string): Address;
  }

  export interface NetworkParameters {
    genesisBlock: string;
    dnsSeeds: string[];
    port: number;
    protocol: {
      magic: number;
    };
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
    bip32: {
      public: number;
      private: number;
    };
  }

  export interface TestParams extends NetworkParameters {}

  export interface UTXO {
    txid: string;
    vout: number;
    scriptPubKey: string;
    amount: number;
    height: number;
    value: number;
    index: number;
    script: string;
  }

  export interface Wallet {
    ecKey: ECKey;
    address: Address;
    balance: number;
    utxos: UTXO[];
    createTransaction(to: string, amount: number): any;
    signTransaction(tx: any): any;
  }

  export interface Block {
    hash: string;
    height: number;
    transactions: any[];
  }

  export interface Coin {
    txid: string;
    vout: number;
    amount: number;
  }

  export interface Sha256Hash {
    bytes: Uint8Array;
    toString(): string;
    wrap(bytes: Uint8Array): Sha256Hash;
  }

  export interface Utils {
    sleep(ms: number): Promise<void>;
  }

  export interface Token {
    id: string;
    name: string;
    symbol: string;
    decimals: number;
  }

  export interface MultiSignAddress {
    address: string;
    redeemScript: string;
  }

  export interface TokenType {
    id: string;
    name: string;
    symbol: string;
  }

  export interface MemoInfo {
    memo: string;
    encrypted: boolean;
  }

  export interface CoinConstants {
    DUST: number;
    MAX_MONEY: number;
  }

  export interface Base58 {
    encode(buffer: Uint8Array): string;
    decode(str: string): Uint8Array;
  }

  export interface GetBalancesResponse {
    balances: any[];
  }

  export interface GetOutputsResponse {
    outputs: any[];
  }

  export interface GetTokensResponse {
    tokens: any[];
  }

  export interface TokenIndexResponse {
    tokens: any[];
  }

  export interface GetMarketPricesResponse {
    prices: any[];
  }

  export interface GetUserDataResponse<T> {
    data: T;
  }

  export class ReqCmd {
    static GetBalances: string;
    static GetOutputs: string;
    static GetTokensItemList: string;
    static GetMyValidTokenItemList: string;
    GetUserData: string;
  }

  export class OkHttp3Util {
    static get(url: string): Promise<any>;
    static post(url: string, data: any): Promise<any>;
  }

  export class Json {
    static parse(str: string): any;
    static stringify(obj: any): string;
  }

  export class WalletUtil {
    static createWallet(): any;
  }

  export class TransactionOutPoint {
    constructor(params: any, index: bigint, hash: Sha256Hash);
  }

  export class TransactionInput {
    constructor(params: any, sequence: any, script: Uint8Array, outpoint: TransactionOutPoint);
  }

  export class TransactionOutput {
    constructor(params: any, lockTime: any, coin: any, script: any);
  }

  export class Coin {
    constructor(amount: bigint, tokenId: Uint8Array);
  }

  export class Script {
    static createOutputScript(address: Address): any;
  }

  export class Transaction {
    constructor(params: any);
    addInput(input: TransactionInput): void;
    addOutput(output: TransactionOutput): void;
  }

  // Export all the interfaces and classes
  export {
    ECKey,
    Address,
    NetworkParameters,
    TestParams,
    UTXO,
    Wallet,
    Block,
    Coin,
    Sha256Hash,
    Utils,
    Token,
    MultiSignAddress,
    TokenType,
    MemoInfo,
    CoinConstants,
    Base58,
    GetBalancesResponse,
    GetOutputsResponse,
    GetTokensResponse,
    TokenIndexResponse,
    GetMarketPricesResponse,
    GetUserDataResponse,
    TransactionOutPoint,
    TransactionInput,
    TransactionOutput,
    Transaction,
  };
}