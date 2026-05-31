/**
 * API Types for Bigtangle Network
 *
 * Type definitions for API requests and responses
 */

/**
 * Request commands
 */
export enum ReqCmd {
  SearchExchangeTokens = 'searchExchangeTokens',
  GetBalances = 'getBalances',
  GetOutputs = 'getOutputs',
  GetUserData = 'getUserData',
  GetTokensItemList = 'getTokensItemList',
  GetMyValidTokenItemList = 'getMyValidTokenItemList',
}

/**
 * User data types
 */
export enum UserDataType {
  ContactInfo = 'CONTACTINFO',
  Token = 'TOKEN',
  Language = 'LANG',
  Settings = 'SETTINGS',
}

/**
 * Market price data
 */
export interface MarketPrice {
  tokenid: string;
  tokenname: string;
  price: string;
  change: string;
  executedquantity: string;
  url?: string;
}

/**
 * Token item
 */
export interface TokenItem {
  tokenid: string;
  tokenname: string;
  tokendomain?: string;
  decimals?: number;
  description?: string;
}

/**
 * Wallet account item (asset with balance)
 */
export interface WalletAccountItem {
  tokenid: string;
  tokenname: string;
  balance: string;
  confirmedBalance: string;
  unconfirmedBalance: string;
  decimals: number;
  tokendisplay?: string;
}

/**
 * Contact information
 */
export interface ContactInfo {
  name: string;
  address: string;
  memo?: string;
}

/**
 * Transaction history item
 */
export interface TransactionHistoryItem {
  txhash: string;
  tokenid: string;
  tokenname: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
  time: number;
  confirmed: boolean;
  memo?: string;
}

/**
 * UTXO (Unspent Transaction Output)
 */
export interface UTXO {
  txhash: string;
  index: number;
  value: string;
  tokenid: string;
  address: string;
  confirmed: boolean;
  spendable: boolean;
  script?: string;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

/**
 * Get balances response
 */
export interface GetBalancesResponse {
  balances: WalletAccountItem[];
}

/**
 * Get outputs (UTXOs) response
 */
export interface GetOutputsResponse {
  outputs: UTXO[];
}

/**
 * Get tokens response
 */
export interface GetTokensResponse {
  tokens: TokenItem[];
}

/**
 * Get market prices response
 */
export interface GetMarketPricesResponse {
  prices: MarketPrice[];
}

/**
 * Get user data response
 */
export interface GetUserDataResponse<T> {
  data: T[];
}

/**
 * Payment request data (from QR code)
 */
export interface PaymentRequest {
  address: string;
  amount?: string;
  tokenid?: string;
  memo?: string;
}

/**
 * Market order
 */
export interface MarketOrder {
  orderid?: string;
  side: 'buy' | 'sell';
  tokenid: string;
  tokenname: string;
  baseTokenid: string;
  baseTokenname: string;
  price: string;
  amount: string;
  startTime?: number;
  endTime?: number;
  status?: 'pending' | 'active' | 'filled' | 'cancelled';
}
