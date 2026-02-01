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
  ReqCmd,
  UserDataType,
  type WalletAccountItem,
  type UTXO,
  type TokenItem,
  type MarketPrice,
  type ContactInfo,
} from '@/types/api';

/**
 * Default API endpoints
 */
const DEFAULT_MAINNET_URL = 'https://p.bigtangle.org:8088/';
const DEFAULT_TESTNET_URL = 'https://testp.bigtangle.org:8088/';
const DEFAULT_MOBILE_URL = 'https://m.bigtangle.org';
const DEFAULT_MOBILE_TEST_URL = 'https://testm.bigtangle.org';
const AI_CHAT_URL = 'https://bigtangle.de:8092/relay';

/**
 * Storage keys
 */
const STORAGE_KEYS = {
  SERVER_URL: ['settings', 'serverUrl'],
  USE_TESTNET: ['settings', 'useTestnet'],
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
   * Set testnet mode
   */
  setTestnet(useTestnet: boolean): void {
    device.set(STORAGE_KEYS.USE_TESTNET, useTestnet.toString());
  }

  /**
   * Make HTTP request
   */
  private async request<T>(
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

    return response as ApiResponse<WalletAccountItem[]>;
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

    return response as ApiResponse<UTXO[]>;
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

    return response as ApiResponse<TokenItem[]>;
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

    return response as ApiResponse<WalletAccountItem[]>;
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

    return response as ApiResponse<MarketPrice[]>;
  }

  /**
   * Search exchange tokens
   */
  async searchExchangeTokens(keyword?: string): Promise<ApiResponse<TokenItem[]>> {
    const response = await this.request<GetTokensResponse>(
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

    return response as ApiResponse<TokenItem[]>;
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

    return response as ApiResponse<T[]>;
  }

  /**
   * Get contacts
   */
  async getContacts(address: string): Promise<ApiResponse<ContactInfo[]>> {
    return this.getUserData<ContactInfo>(address, UserDataType.ContactInfo);
  }

  /**
   * AI Chat query
   */
  async aiChatQuery(question: string): Promise<ApiResponse<string>> {
    try {
      const response = await this.request<any>(
        '',
        'POST',
        {
          messages: [
            {
              role: 'user',
              content: question,
            },
          ],
        },
        AI_CHAT_URL
      );

      if (response.success && response.data) {
        // Parse AI response
        const choices = response.data.choices;
        if (choices && choices.length > 0) {
          const answer = choices[0].message?.content || 'No response';
          return {
            success: true,
            data: answer,
          };
        }
      }

      return {
        success: false,
        error: 'No response from AI',
      };
    } catch (error) {
      console.error('[HTTP] AI Chat failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
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
