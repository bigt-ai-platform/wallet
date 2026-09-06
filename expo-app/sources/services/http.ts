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
  type BridgeInfo,
  type OrderInfo,
  type ChainNumberInfo,
  type OutputDetail,
} from '@/types/api';
import { PQKey, Utils, MainNetParams, TestParams } from 'bigtangle-ts';
import { DEFAULT_L1_CHAINS_MAINNET, DEFAULT_L1_CHAINS_TESTNET, IS_DEV, DEV_L0_URL, DEV_L1_URL } from '@/constants/app';

/**
 * Default API endpoints.
 *
 * The L0 (main chain) server URL is discovered from the network seeds defined
 * in the blockchain params (Java `RequesterSeedDiscovery`): each
 * `serverSeeds()` entry is an "host:port" HTTP seed server. DNS enrtree seeds
 * and UDP-discovered peers are added server-side; the browser client only
 * needs the static HTTP seed list.
 *
 * Development builds point at the local dev-server endpoints instead
 * (dev.sh: L0 :24089, L1 :24086).
 *
 * The L1 (order match) chains carry no seed list of their own, so they keep
 * the well-known configured defaults below.
 */
function discoverL0Url(useTestnet: boolean): string {
  if (IS_DEV) {
    return DEV_L0_URL;
  }
  const params = useTestnet ? TestParams.get() : MainNetParams.get();
  const seeds = params.serverSeeds();
  if (seeds && seeds.length > 0) {
    return `http://${seeds[0].trim()}/`;
  }
  return '';
}
const DEFAULT_L1_MAINNET_URL = 'https://m.bigtangle.org';
const DEFAULT_L1_TESTNET_URL = 'https://testm.bigtangle.org';

/** The default L1 order-match URL for the given network (local in dev). */
function defaultL1Url(useTestnet: boolean): string {
  if (IS_DEV) {
    return DEV_L1_URL;
  }
  return useTestnet ? DEFAULT_L1_TESTNET_URL : DEFAULT_L1_MAINNET_URL;
}

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Storage keys
 */
const STORAGE_KEYS = {
  SERVER_URL: ['settings', 'serverUrl'],
  L1_URL: ['settings', 'l1Url'],
  USE_TESTNET: ['settings', 'useTestnet'],
  L1_CHAINS: ['settings', 'l1Chains'],
  ACTIVE_L1: ['settings', 'activeL1Index'],
};

/**
 * Subscribers notified whenever the L1 chain configuration or the active L1
 * chain changes, so every screen can re-render from one source of truth.
 */
type L1Listener = () => void;
const l1Listeners = new Set<L1Listener>();

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
   * Whether testnet mode is switched on (settings 'useTestnet' flag).
   */
  getUseTestnet(): boolean {
    return device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
  }

  /**
   * Get the current server URL
   */
  getServerUrl(): string {
    const savedUrl = device.get(STORAGE_KEYS.SERVER_URL);
    if (savedUrl) {
      return savedUrl;
    }

    return this.getDefaultServerUrl();
  }

  /**
   * The network default L0 URL — discovered from the seeds for the currently
   * selected network. Ignored when a URL is explicitly saved in settings.
   */
  getDefaultServerUrl(): string {
    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    return discoverL0Url(useTestnet);
  }

  /**
   * Set the server URL
   */
  setServerUrl(url: string): void {
    device.set(STORAGE_KEYS.SERVER_URL, url);
  }

  /**
   * Get the L1 (Order Match) server URL — the ACTIVE chain's URL.
   */
  getL1Url(): string {
    const active = this.getActiveL1Chain();
    if (active?.url) {
      return active.url;
    }
    const savedUrl = device.get(STORAGE_KEYS.L1_URL);
    if (savedUrl) {
      return savedUrl;
    }
    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    return defaultL1Url(useTestnet);
  }

  /**
   * The on-chain id of the currently active L1 chain (single source of truth
   * for all screens). Falls back to the first configured chain; returns ''
   * when none are configured.
   */
  getActiveL1ChainId(): string {
    const chains = this.getL1Chains();
    if (chains.length === 0) return '';
    const activeId = (device.get(STORAGE_KEYS.ACTIVE_L1) ?? '').trim();
    if (!activeId) return chains[0].chainId;
    // Migration: an older build stored a numeric index here.
    if (/^\d+$/.test(activeId)) {
      const oldIdx = Math.min(Math.max(Number(activeId), 0), chains.length - 1);
      return chains[oldIdx].chainId;
    }
    return chains.some((c) => c.chainId === activeId) ? activeId : chains[0].chainId;
  }

  /**
   * Set the active L1 chain by on-chain id and notify subscribers.
   */
  setActiveL1ChainId(chainId: string): void {
    device.set(STORAGE_KEYS.ACTIVE_L1, chainId);
    this.notifyL1Change();
  }

  /**
   * The currently active L1 chain config (or null when none configured).
   */
  getActiveL1Chain(): L1ChainConfig | null {
    const chains = this.getL1Chains();
    const id = this.getActiveL1ChainId();
    return chains.find((c) => c.chainId === id) ?? null;
  }

  /**
   * Subscribe to L1 chain config / active-chain changes.
   * Returns an unsubscribe function.
   */
  subscribeL1Change(listener: L1Listener): () => void {
    l1Listeners.add(listener);
    return () => l1Listeners.delete(listener);
  }

  private notifyL1Change(): void {
    for (const fn of Array.from(l1Listeners)) {
      try { fn(); } catch { /* listener errors must not break others */ }
    }
  }

  /**
   * Set the L1 (Order Match) server URL
   */
  setL1Url(url: string): void {
    device.set(STORAGE_KEYS.L1_URL, url);
  }

  /**
   * Set testnet mode — resets the L0 URL AND swaps the L1 chain set to the
   * matching network defaults, so the layer display always follows network.
   */
  setTestnet(useTestnet: boolean): void {
    device.set(STORAGE_KEYS.USE_TESTNET, useTestnet.toString());
    this.setL1Chains(useTestnet ? DEFAULT_L1_CHAINS_TESTNET.slice() : DEFAULT_L1_CHAINS_MAINNET.slice());
    const defaults = useTestnet ? DEFAULT_L1_CHAINS_TESTNET : DEFAULT_L1_CHAINS_MAINNET;
    this.setActiveL1ChainId(defaults[0].chainId);
    this.notifyL1Change();
  }

  /**
   * Get all configured L1 chains. Older configs saved without a chainId are
   * back-filled on read so every chain is keyable by its unique on-chain id.
   */
  getL1Chains(): L1ChainConfig[] {
    const stored = device.get(STORAGE_KEYS.L1_CHAINS);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((c, i) => ({
            chainId: typeof c?.chainId === 'string' && c.chainId ? c.chainId : (i === 0 ? 'ordermatch' : `chain-${i}`),
            name: c?.name || '',
            url: c?.url || '',
          }));
        }
      } catch { /* fall through */ }
    }
    const savedUrl = device.get(STORAGE_KEYS.L1_URL);
    const useTestnet = device.get(STORAGE_KEYS.USE_TESTNET) === 'true';
    const singleUrl = savedUrl || defaultL1Url(useTestnet);
    return [{ chainId: 'ordermatch', name: 'Default', url: singleUrl }];
  }

  /**
   * Save all L1 chains
   */
  setL1Chains(chains: L1ChainConfig[]): void {
    device.set(STORAGE_KEYS.L1_CHAINS, JSON.stringify(chains));
    this.notifyL1Change();
  }

  /**
   * Add a new L1 chain. chainId must be a non-empty, unique on-chain id
   * ('0' is reserved for Layer 0/settlement). Returns a machine error code
   * ('chainIdEmpty' | 'chainIdReserved' | 'chainIdExists') or null on success.
   */
  addL1Chain(chainId: string, name: string, url: string): string | null {
    const id = chainId.trim();
    if (!id) return 'chainIdEmpty';
    if (id === '0') return 'chainIdReserved';
    const chains = this.getL1Chains();
    if (chains.some((c) => c.chainId === id)) return 'chainIdExists';
    chains.push({ chainId: id, name: name.trim(), url: url.trim() });
    this.setL1Chains(chains);
    this.notifyL1Change();
    return null;
  }

  /**
   * Remove an L1 chain by index
   */
  removeL1Chain(index: number): void {
    const chains = this.getL1Chains();
    if (index < 0 || index >= chains.length) return;
    const removed = chains[index];
    chains.splice(index, 1);
    this.setL1Chains(chains);
    // If the removed chain was the active one, fall back to the first remaining.
    if (removed.chainId === this.getActiveL1ChainId()) {
      this.setActiveL1ChainId(chains.length > 0 ? chains[0].chainId : '');
    }
    this.notifyL1Change();
  }

  /**
   * Update an L1 chain at index. chainId must stay non-empty and unique among
   * the other chains ('0' is reserved for Layer 0/settlement). Returns a
   * machine error code or null on success.
   */
  updateL1Chain(index: number, chainId: string, name: string, url: string): string | null {
    const chains = this.getL1Chains();
    if (index < 0 || index >= chains.length) return 'chainNotFound';
    const id = chainId.trim();
    if (!id) return 'chainIdEmpty';
    if (id === '0') return 'chainIdReserved';
    if (chains.some((c, i) => i !== index && c.chainId === id)) return 'chainIdExists';
    const wasActive = chains[index].chainId === this.getActiveL1ChainId();
    chains[index] = { chainId: id, name: name.trim(), url: url.trim() };
    this.setL1Chains(chains);
    if (wasActive) {
      device.set(STORAGE_KEYS.ACTIVE_L1, id);
    }
    this.notifyL1Change();
    return null;
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
      const base = baseUrl ? baseUrl : this.getServerUrl();
      // Base URLs may be configured without a trailing slash (settings input,
      // L1 chain URL, defaults) — normalize so `${base}${endpoint}` is valid.
      const url = `${base.endsWith('/') ? base : base + '/'}${endpoint}`;

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
   * Get account balances. The Java server's getBalances expects a JSON array
   * of hex pubkey hashes (not an address), so the wallet's private key is
   * required to derive the pubkey hash.
   */
  async getBalances(privateKeyHex: string): Promise<ApiResponse<WalletAccountItem[]>> {
    const items = await this.fetchAccountBalances(privateKeyHex);
    return { success: true, data: items };
  }

  /**
   * Get account balances from a specific chain URL (e.g. an L1 order chain),
   * not just the default L0 server.
   */
  async getBalancesOn(baseUrl: string, privateKeyHex: string): Promise<ApiResponse<WalletAccountItem[]>> {
    const items = await this.fetchAccountBalances(privateKeyHex, baseUrl);
    return { success: true, data: items };
  }

  /**
   * Fetch L0 bridge info (vault script + active flag) for the peg-in flow.
   */
  async getBridgeInfo(): Promise<ApiResponse<BridgeInfo>> {
    const response = await this.request<any>(ReqCmd.GetBridgeInfo, 'POST', {});
    if (!response.success || !response.data) {
      return { success: false, error: 'Failed to fetch bridge info' };
    }
    return {
      success: true,
      data: {
        active: !!response.data.active,
        vaultAddress: response.data.vaultAddress || '',
        vaultScriptHex: response.data.vaultScriptHex || '',
      },
    };
  }

  private async fetchAccountBalances(privateKeyHex: string, baseUrl?: string): Promise<WalletAccountItem[]> {
    const pqKey = PQKey.fromPrivateKey(hexToBytes(privateKeyHex));
    const pubKeyHash = Utils.HEX.encode(pqKey.getPubKeyHash());
    const response = await this.request<any>(ReqCmd.GetBalances, 'POST', [pubKeyHash], baseUrl);
    if (!response.success || !response.data) return [];
    const balances: any[] = response.data.balance || [];
    const tokennames: Record<string, any> = response.data.tokennames || {};
    return balances.map((c: any) => {
      const tokenid: string = c.tokenHex || c.tokenid || 'bc';
      const token = tokennames[tokenid] || {};
      const decimals = typeof token.decimals === 'number' ? token.decimals : tokenid === 'bc' ? 8 : 0;
      const value = BigInt(c.value || 0);
      const human = Number(value) / Math.pow(10, decimals);
      return {
        tokenid,
        tokenname: token.tokenname || (tokenid === 'bc' ? 'BIG' : tokenid),
        balance: String(human),
        confirmedBalance: String(human),
        unconfirmedBalance: '0',
        decimals,
      };
    });
  }

  /**
   * Get UTXOs for a wallet. The Java server's getOutputs expects a JSON array
   * of hex pubkey hashes (not an address).
   */
  async getOutputs(privateKeyHex: string): Promise<ApiResponse<UTXO[]>> {
    const pqKey = PQKey.fromPrivateKey(hexToBytes(privateKeyHex));
    const pubKeyHash = Utils.HEX.encode(pqKey.getPubKeyHash());
    const response = await this.request<any>(ReqCmd.GetOutputs, 'POST', [pubKeyHash]);
    if (response.success && response.data) {
      return {
        success: true,
        data: (response.data.outputs || []) as UTXO[],
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
   * Get the chain's justified/finalized Casper checkpoints (finalizedChainLength
   * is used to mark UTXOs as finalized on the balance screen).
   */
  async getChainNumber(baseUrl?: string): Promise<ApiResponse<ChainNumberInfo>> {
    return this.request<ChainNumberInfo>(ReqCmd.GetChainNumber, 'POST', {}, baseUrl);
  }

  /**
   * Fetch one output's detail + its containing block info (balance "… for more").
   * `hex` is "blockHashHex:outputIndex" (same format as getOutputByKey).
   */
  async getOutputDetail(hex: string, baseUrl?: string): Promise<ApiResponse<OutputDetail>> {
    return this.request<OutputDetail>(ReqCmd.GetOutputDetail, 'POST', { hex }, baseUrl);
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
    // The L0 server exposes the confirmed-token list via `searchTokens` (empty
    // name returns all tokens); there is no `getTokensItemList` ReqCmd.
    const response = await this.request<GetTokensResponse>(
      'searchTokens',
      'POST',
      { name: '' },
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
  async getMyValidTokenItemList(privateKeyHex: string): Promise<ApiResponse<WalletAccountItem[]>> {
    const items = await this.fetchAccountBalances(privateKeyHex);
    return {
      success: true,
      data: items,
    };
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
   * Make HTTP request to a specific L1 chain by on-chain id
   */
  async requestL1ByChainId<T>(
    chainId: string,
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any,
  ): Promise<ApiResponse<T>> {
    const chain = this.getL1Chains().find((c) => c.chainId === chainId);
    if (!chain) {
      return { success: false, error: 'L1 chain not found' };
    }
    return this.request(endpoint, method, body, chain.url);
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
