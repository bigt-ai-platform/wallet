/**
 * EVM chain registry. One signer (the wallet's EC key) serves every chain here;
 * only chainId, RPC base, explorer and the token list change.
 *
 * The RPC base is always a proxy we control (same-origin `/eth` on the web
 * build, the region host on native) so no provider key ships in the bundle —
 * see `deploy/region.sh` and `docs/assets-deposit-withdraw.md` §10.
 */

import { IS_WEB_BROWSER } from '@/constants/app';

export interface EthToken {
  /** ERC-20 contract address (checksummed display form). */
  address: string;
  symbol: string;
  name?: string;
  /** Display decimals; verified against `decimals()` on first use. */
  decimals: number;
}

export interface EthChain {
  id: 'mainnet' | 'sepolia';
  name: string;
  chainId: number;
  nativeSymbol: string;
  /** Public explorer base, for transaction links. */
  explorer: string;
  /** Built-in tokens offered on this chain. */
  tokens: EthToken[];
  /** Testnet chains are only offered in dev/e2e/custom setups. */
  testnet?: boolean;
}

/** Public proxy host used by native builds (the apex region vhost). */
export const ETH_PROXY_URL = 'https://wallet.bigt.ai/eth';

/** Same-origin path on the web production build (`deploy/region.sh`). */
export const ETH_PROXY_PATH = '/eth';

/** Base URL for the JSON-RPC proxy on the current platform. */
export function defaultEthRpcUrl(): string {
  if (process.env.EXPO_PUBLIC_ETH_RPC_URL) return process.env.EXPO_PUBLIC_ETH_RPC_URL;
  return IS_WEB_BROWSER ? ETH_PROXY_PATH : ETH_PROXY_URL;
}

export const ETH_MAINNET: EthChain = {
  id: 'mainnet',
  name: 'Ethereum',
  chainId: 1,
  nativeSymbol: 'ETH',
  explorer: 'https://etherscan.io',
  tokens: [
    {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
    },
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
};

export const ETH_SEPOLIA: EthChain = {
  id: 'sepolia',
  name: 'Sepolia',
  chainId: 11155111,
  nativeSymbol: 'ETH',
  explorer: 'https://sepolia.etherscan.io',
  testnet: true,
  tokens: [],
};

export const ETH_CHAINS: EthChain[] = [ETH_MAINNET, ETH_SEPOLIA];

export function findEthChain(id: string): EthChain {
  return ETH_CHAINS.find((c) => c.id === id) ?? ETH_MAINNET;
}

/** Explorer URL of a transaction or address. */
export function ethExplorerTx(chain: EthChain, hash: string): string {
  return `${chain.explorer}/tx/${hash}`;
}

export function ethExplorerAddress(chain: EthChain, address: string): string {
  return `${chain.explorer}/address/${address}`;
}
