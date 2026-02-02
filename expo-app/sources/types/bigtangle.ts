/**
 * Mock types for @bigtangle/bigtangle-ts library
 * These are temporary definitions to resolve TypeScript errors
 * until the actual library is properly installed
 */

export interface ECKey {
  publicKey: Uint8Array;
  privateKey?: Uint8Array;
  compressed: boolean;
}

export interface Address {
  scriptHash: string;
  toString(): string;
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
}

export interface Utils {
  // Add commonly used utility methods
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
  constructor(command: string, params?: any) {}
}

export class OkHttp3Util {
  static get(url: string): Promise<any> {
    return Promise.resolve({});
  }

  static post(url: string, data: any): Promise<any> {
    return Promise.resolve({});
  }
}

export class Json {
  static parse(str: string): any {
    return {};
  }

  static stringify(obj: any): string {
    return '{}';
  }
}

export class WalletUtil {
  static createWallet(): any {
    return {};
  }
}