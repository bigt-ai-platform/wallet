/**
 * HTTP Service for Bigtangle API
 *
 * Handles all HTTP communication with Bigtangle network
 */

import { device } from '@/storage';
import {
  type ApiResponse,
  type GetBalancesResponse,
  type GetOutputsResponse,
  type GetTokensResponse,
  type GetMarketPricesResponse,
  type GetUserDataResponse,
  type GetTransactionStatusesResponse,
  type TransactionStatusInfo,
  ReqCmd,
  UserDataType,
  type WalletAccountItem,
  type UTXO,
  type TokenItem,
  type MarketPrice,
  type ContactInfo,
  type L1ChainConfig,
  type OrderInfo,
} from '@/types/api';

/**
 * Default API endpoints
 */
const DEFAULT_MAINNET_URL = 'https://p.bigtangle.org:8088/';
const DEFAULT_TESTNET_URL = 'https://testp.bigtangle.org:8088/';
const DEFAULT_L1_MAINNET_URL = 'https://m.bigtangle.org';
const DEFAULT_L1_TESTNET_URL = 'https://testm.bigtangle.org';

/**
 * Storage keys
 */
const STORAGE_KEYS = {
  SERVER_URL: ['settings', 'serverUrl'],
  L1_URL: ['settings', 'l1Url'],
  USE_TESTNET: ['settings', 'useTestnet'],
  L1_CHAINS: ['settings', 'l1Chains'],
};

/**
 * HTTP Service class
 */
export class HttpService {
  private static instance: HttpService;

  private constructor() {}

  static getInstance(): HttpService {
    if (!HttpService.instance) {
      HttpService.instance = new HttpService();
    }
    return HttpService.instance;
  }

  /**
   * Get the current server URL
   */
  getServerUrl(): string {
    const savedUrl = device.get(STORAGE_KEYS.SERVER_URL);
    if (savedUrl) {
      return savedUrl;
    }

    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    return useTestnet ? DEFAULT_TESTNET_URL : DEFAULT_MAINNET_URL;
  }

  /**
   * Set the server URL
   */
  setServerUrl(url: string): void {
    device.set(STORAGE_KEYS.SERVER_URL, url);
  }

  /**
   * Get the L1 (Order Match) server URL
   */
  getL1Url(): string {
    const chains = this.getL1Chains();
    if (chains.length > 0 && chains[0].url) {
      return chains[0].url;
    }
    const savedUrl = device.get(STORAGE_KEYS.L1_URL);
    if (savedUrl) {
      return savedUrl;
    }
    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    return useTestnet ? DEFAULT_L1_TESTNET_URL : DEFAULT_L1_MAINNET_URL;
  }

  /**
   * Set the L1 (Order Match) server URL
   */
  setL1Url(url: string): void {
    device.set(STORAGE_KEYS.L1_URL, url);
  }

  /**
   * Set testnet mode — resets both L0 and L1 URLs to defaults
   */
  setTestnet(useTestnet: boolean): void {
    device.set(STORAGE_KEYS.USE_TESTNET, useTestnet.toString());
  }

  /**
   * Get all configured L1 chains
   */
  getL1Chains(): L1ChainConfig[] {
    const stored = device.get(STORAGE_KEYS.L1_CHAINS);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch { /* fall through */ }
    }
    const savedUrl = device.get(STORAGE_KEYS.L1_URL);
    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    const singleUrl = savedUrl || (useTestnet ? DEFAULT_L1_TESTNET_URL : DEFAULT_L1_MAINNET_URL);
    return [{ name: 'Default', url: singleUrl }];
  }

  /**
   * Save all L1 chains
   */
  setL1Chains(chains: L1ChainConfig[]): void {
    device.set(STORAGE_KEYS.L1_CHAINS, JSON.stringify(chains));
  }

  /**
   * Add a new L1 chain
   */
  addL1Chain(name: string, url: string): void {
    const chains = this.getL1Chains();
    chains.push({ name, url });
    this.setL1Chains(chains);
  }

  /**
   * Remove an L1 chain by index
   */
  removeL1Chain(index: number): void {
    const chains = this.getL1Chains();
    if (index >= 0 && index < chains.length) {
      chains.splice(index, 1);
      this.setL1Chains(chains);
    }
  }

  /**
   * Update an L1 chain at index
   */
  updateL1Chain(index: number, name: string, url: string): void {
    const chains = this.getL1Chains();
    if (index >= 0 && index < chains.length) {
      chains[index] = { name, url };
      this.setL1Chains(chains);
    }
  }

  /**
   * Make HTTP request
   */
  async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any,
    baseUrl?: string
  ): Promise<ApiResponse<T>> {
    try {
      const url = baseUrl ? `${baseUrl}${endpoint}` : `${this.getServerUrl()}${endpoint}`;

      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (body && method === 'POST') {
        options.body = JSON.stringify(body);
      }

      console.log(`[HTTP] ${method} ${url}`);

      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        success: true,
        data,
      };
    } catch (error) {
      console.error('[HTTP] Request failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get account balances
   */
  async getBalances(address: string): Promise<ApiResponse<WalletAccountItem[]>> {
    const response = await this.request<GetBalancesResponse>(
      ReqCmd.GetBalances,
      'POST',
      { address }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.balances,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get balances',
    } as ApiResponse<WalletAccountItem[]>;
  }

  /**
   * Get UTXOs for an address
   */
  async getOutputs(address: string, tokenid?: string): Promise<ApiResponse<UTXO[]>> {
    const response = await this.request<GetOutputsResponse>(
      ReqCmd.GetOutputs,
      'POST',
      { address, tokenid }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.outputs,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get outputs',
    } as ApiResponse<UTXO[]>;
  }

  /**
   * Get UTXO history for an address with optional from/to date filter.
   * starttime/endtime are epoch seconds. Filters by toaddress when provided.
   */
  async getOutputsHistory(params: {
    address?: string;
    toAddress?: string;
    fromTime?: number;
    toTime?: number;
    baseUrl?: string;
  }): Promise<ApiResponse<UTXO[]>> {
    const response = await this.request<GetOutputsResponse>(
      ReqCmd.GetOutputsHistory,
      'POST',
      {
        fromaddress: params.address || '',
        toaddress: params.toAddress || '',
        starttime: params.fromTime ?? null,
        endtime: params.toTime ?? null,
      },
      params.baseUrl
    );
    if (response.success && response.data) {
      return { success: true, data: response.data.outputs };
    }
    return {
      success: false,
      error: response.error || 'Failed to get outputs history',
    } as ApiResponse<UTXO[]>;
  }

  /**
   * Get the on-chain lifecycle status of a single transaction
   */
  async getTransactionStatus(txHash: string): Promise<ApiResponse<TransactionStatusInfo>> {
    const response = await this.request<TransactionStatusInfo>(
      ReqCmd.GetTransactionStatus,
      'POST',
      { txHash }
    );

    if (response.success && response.data) {
      return { success: true, data: response.data };
    }
    return {
      success: false,
      error: response.error || 'Failed to get transaction status',
    } as ApiResponse<TransactionStatusInfo>;
  }

  /**
   * Get the on-chain lifecycle status of a single transaction on a specific
   * chain (L1 order chains inherit the endpoint from BaseDispatcherController).
   */
  async getTransactionStatusOnChain(
    txHash: string,
    baseUrl: string
  ): Promise<ApiResponse<TransactionStatusInfo>> {
    const response = await this.request<TransactionStatusInfo>(
      ReqCmd.GetTransactionStatus,
      'POST',
      { txHash },
      baseUrl
    );

    if (response.success && response.data) {
      return { success: true, data: response.data };
    }
    return {
      success: false,
      error: response.error || 'Failed to get transaction status',
    } as ApiResponse<TransactionStatusInfo>;
  }

  /**
   * Get transaction lifecycle statuses for all transactions of an address
   */
  async getTransactionsStatusByAddress(address: string): Promise<ApiResponse<TransactionStatusInfo[]>> {
    const response = await this.request<GetTransactionStatusesResponse>(
      ReqCmd.GetTransactionsStatusByAddress,
      'POST',
      { address }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.transactions || [],
      };
    }
    return {
      success: false,
      error: response.error || 'Failed to get transaction statuses',
    } as ApiResponse<TransactionStatusInfo[]>;
  }

  /**
   * Get all available tokens
   */
  async getTokensItemList(): Promise<ApiResponse<TokenItem[]>> {
    const response = await this.request<GetTokensResponse>(
      ReqCmd.GetTokensItemList,
      'POST'
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.tokens,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get tokens list',
    } as ApiResponse<TokenItem[]>;
  }

  /**
   * Get user's tokens with balances
   */
  async getMyValidTokenItemList(address: string): Promise<ApiResponse<WalletAccountItem[]>> {
    const response = await this.request<GetBalancesResponse>(
      ReqCmd.GetMyValidTokenItemList,
      'POST',
      { address }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.balances,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get user token items',
    } as ApiResponse<WalletAccountItem[]>;
  }

  /**
   * Get market prices
   */
  async getMarketPrices(): Promise<ApiResponse<MarketPrice[]>> {
    const response = await this.request<GetMarketPricesResponse>(
      'getMarketPrices',
      'POST'
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.prices,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get market prices',
    } as ApiResponse<MarketPrice[]>;
  }

  /**
   * Make HTTP request to the L1 (Order Match) server
   */
  async requestL1<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any,
  ): Promise<ApiResponse<T>> {
    return this.request(endpoint, method, body, this.getL1Url());
  }

  /**
   * Make HTTP request to a specific L1 chain by index
   */
  async requestL1ByIndex<T>(
    index: number,
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any,
  ): Promise<ApiResponse<T>> {
    const chains = this.getL1Chains();
    if (index < 0 || index >= chains.length) {
      return { success: false, error: 'L1 chain not found' };
    }
    return this.request(endpoint, method, body, chains[index].url);
  }

  /**
   * Get orders for given token IDs (L1)
   */
  async getOrders(tokenids: string[], baseToken?: string): Promise<ApiResponse<any>> {
    const response = await this.requestL1<any>('getOrders', 'POST', { tokenids, basetoken: baseToken || '' });
    if (response.success && response.data) return { success: true, data: response.data };
    return { success: false, error: response.error || 'Failed to get orders' } as ApiResponse<any>;
  }

  /**
   * Get open orders for an address on the L1 order chain
   */
  async getOrdersByAddress(address: string): Promise<ApiResponse<OrderInfo[]>> {
    const response = await this.requestL1<any>('getOrders', 'POST', { address });
    if (response.success && response.data) {
      const orders = response.data.allOrdersSorted || response.data.orders || [];
      return { success: true, data: orders };
    }
    return { success: false, error: response.error || 'Failed to get orders' } as ApiResponse<OrderInfo[]>;
  }

  /**
   * Get order tickers (L1)
   */
  async getOrdersTicker(tokenids: string[], baseToken: string): Promise<ApiResponse<any>> {
    const response = await this.requestL1<any>('getOrdersTicker', 'POST', { tokenids, count: 50, basetoken: baseToken });
    if (response.success && response.data) return { success: true, data: response.data };
    return { success: false, error: response.error || 'Failed to get tickers' } as ApiResponse<any>;
  }

  /**
   * Get a time series of price / executedQuantity for a token from the L1
   * order chain over the given interval (minutes). Mirrors the chartdata
   * `jsondata` endpoint: it calls getOrdersTicker in time-series mode
   * (no `count`, with startDate/endDate/interval) and returns per-token
   * data points [{ price, inserttime, executedQuantity }].
   */
  async getOrdersTickerSeries(
    tokenid: string,
    intervalMinutes: number,
    baseToken: string,
    endDateMs: number = Date.now()
  ): Promise<ApiResponse<any>> {
    const response = await this.requestL1<any>(
      'getOrdersTicker',
      'POST',
      {
        tokenids: [tokenid],
        basetoken: baseToken,
        interval: String(intervalMinutes),
        startDate: endDateMs - intervalMinutes * 60 * 1000,
        endDate: endDateMs,
      }
    );
    if (response.success && response.data) return { success: true, data: response.data };
    return { success: false, error: response.error || 'Failed to get ticker series' } as ApiResponse<any>;
  }

  /**
   * Submit an order transaction (raw hex) (L1)
   */
  async submitOrderTransaction(txHex: string): Promise<ApiResponse<string>> {
    const response = await this.requestL1<string>('submitTransaction', 'POST', { txhex: txHex });
    if (response.success) return { success: true, data: 'ok' };
    return { success: false, error: response.error || 'Failed to submit order' };
  }

  /**
   * Search exchange tokens (L1)
   */
  async searchExchangeTokens(keyword?: string): Promise<ApiResponse<TokenItem[]>> {
    const response = await this.requestL1<GetTokensResponse>(
      ReqCmd.SearchExchangeTokens,
      'POST',
      { keyword }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.tokens,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to search exchange tokens',
    } as ApiResponse<TokenItem[]>;
  }

  /**
   * Get user data (contacts, settings, etc.)
   */
  async getUserData<T = any>(
    address: string,
    dataType: UserDataType
  ): Promise<ApiResponse<T[]>> {
    const response = await this.request<GetUserDataResponse<T>>(
      ReqCmd.GetUserData,
      'POST',
      { address, dataType }
    );

    if (response.success && response.data) {
      return {
        success: true,
        data: response.data.data,
      };
    }

    // Return a properly typed failure response
    return {
      success: false,
      error: response.error || 'Failed to get user data',
    } as ApiResponse<T[]>;
  }

  /**
   * Get contacts
   */
  async getContacts(address: string): Promise<ApiResponse<ContactInfo[]>> {
    return this.getUserData<ContactInfo>(address, UserDataType.ContactInfo);
  }

  /**
   * Download wallet file
   */
  async downloadWalletFile(filename: string): Promise<ApiResponse<Blob>> {
    try {
      const url = `${this.getServerUrl()}downloadWallet?filename=${encodeURIComponent(filename)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();

      return {
        success: true,
        data: blob,
      };
    } catch (error) {
      console.error('[HTTP] Download wallet failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Export singleton instance
 */
export const httpService = HttpService.getInstance();
