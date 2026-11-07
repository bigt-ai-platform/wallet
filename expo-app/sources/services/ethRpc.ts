/**
 * Ethereum JSON-RPC client + per-device settings.
 *
 * The endpoint is either the deploy stack's same-origin `/eth` proxy (web
 * build), the region host (native), or a user override from Settings. Provider
 * API keys stay on the proxy, never in the bundle — see
 * `deploy/region.sh` and `docs/assets-deposit-withdraw.md` §10.
 */

import { device } from '@/storage';
import {
  defaultEthIndexUrl, defaultEthRpcUrl, findEthChain, ETH_CHAINS,
  type EthChain, type EthToken,
} from '@/lib/eth/chains';
import { isAddress } from '@/lib/eth/address';

const SETTINGS_KEY = ['eth', 'settings'];
const TOKENS_KEY = (chainId: number) => ['eth', 'tokens', String(chainId)];

export interface EthSettings {
  network: 'mainnet' | 'sepolia';
  /** Empty = use the platform default (proxy). */
  rpcUrl: string;
  /** Address index for native deposit history; empty = platform default. */
  indexUrl: string;
}

/** Error code used when the endpoint is missing or is not a JSON-RPC proxy. */
export const ETH_RPC_NOT_CONFIGURED = 'eth-rpc-not-configured';

export class EthRpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'EthRpcError';
  }
}

export function getEthSettings(): EthSettings {
  const raw = device.get(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as EthSettings;
      return {
        network: parsed.network === 'sepolia' ? 'sepolia' : 'mainnet',
        rpcUrl: typeof parsed.rpcUrl === 'string' ? parsed.rpcUrl : '',
        indexUrl: typeof parsed.indexUrl === 'string' ? parsed.indexUrl : '',
      };
    } catch {
      /* fall through to defaults */
    }
  }
  return { network: 'mainnet', rpcUrl: '', indexUrl: '' };
}

function writeSettings(next: EthSettings): void {
  device.set(SETTINGS_KEY, JSON.stringify(next));
}

export function setEthNetwork(network: 'mainnet' | 'sepolia'): void {
  writeSettings({ ...getEthSettings(), network });
}

export function setEthRpcUrl(rpcUrl: string): void {
  writeSettings({ ...getEthSettings(), rpcUrl: rpcUrl.trim() });
}

/** Empty restores the platform default index. */
export function setEthIndexUrl(indexUrl: string): void {
  writeSettings({ ...getEthSettings(), indexUrl: indexUrl.trim() });
}

export function getEthChain(): EthChain {
  return findEthChain(getEthSettings().network);
}

/** Resolved endpoint: user override, else the platform proxy default. */
export function ethRpcUrl(): string {
  const custom = getEthSettings().rpcUrl.trim();
  return custom || defaultEthRpcUrl();
}

export function isEthRpcConfigured(): boolean {
  return ethRpcUrl().length > 0;
}

/** Address-index base for native transfer history (Blockscout-compatible). */
export function ethIndexUrl(): string {
  const custom = getEthSettings().indexUrl.trim();
  return custom || process.env.EXPO_PUBLIC_ETH_INDEX_URL || defaultEthIndexUrl();
}

/** Built-in tokens of the chain plus the ones the user added by contract. */
export function getEthTokens(chain: EthChain = getEthChain()): EthToken[] {
  const out = [...chain.tokens];
  const raw = device.get(TOKENS_KEY(chain.chainId));
  if (raw) {
    try {
      const extra = JSON.parse(raw) as EthToken[];
      for (const token of extra) {
        if (!token?.address || !isAddress(token.address)) continue;
        if (out.some((t) => t.address.toLowerCase() === token.address.toLowerCase())) continue;
        out.push(token);
      }
    } catch {
      /* ignore a corrupt list */
    }
  }
  return out;
}

export function addEthToken(token: EthToken, chain: EthChain = getEthChain()): void {
  const existing = getEthTokens(chain);
  if (existing.some((t) => t.address.toLowerCase() === token.address.toLowerCase())) {
    throw new Error('Token already added');
  }
  const extra = existing.filter(
    (t) => !chain.tokens.some((b) => b.address.toLowerCase() === t.address.toLowerCase())
  );
  device.set(TOKENS_KEY(chain.chainId), JSON.stringify([...extra, token]));
}

export function removeEthToken(address: string, chain: EthChain = getEthChain()): void {
  const extra = getEthTokens(chain).filter(
    (t) =>
      !chain.tokens.some((b) => b.address.toLowerCase() === t.address.toLowerCase()) &&
      t.address.toLowerCase() !== address.toLowerCase()
  );
  device.set(TOKENS_KEY(chain.chainId), JSON.stringify(extra));
}

/** Chains offered in Settings: mainnet always, testnets only when configured. */
export function selectableEthChains(): EthChain[] {
  const mainnet = ETH_CHAINS.filter((c) => !c.testnet);
  const testnets = ETH_CHAINS.filter((c) => c.testnet);
  return [...mainnet, ...testnets];
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 0;

/** One JSON-RPC call with a 20 s timeout; throws {@link EthRpcError}. */
export async function ethRpc<T>(
  method: string,
  params: unknown[] = [],
  opts: { url?: string; timeoutMs?: number } = {}
): Promise<T> {
  const url = opts.url ?? ethRpcUrl();
  if (!url) throw new EthRpcError(-32000, ETH_RPC_NOT_CONFIGURED);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000)
    : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: controller?.signal,
    });
    if (!res.ok) {
      // 404/405 means the deploy stack has no `/eth` route yet.
      const notConfigured = res.status === 404 || res.status === 405;
      throw new EthRpcError(res.status, notConfigured ? ETH_RPC_NOT_CONFIGURED : `Ethereum RPC HTTP ${res.status}`);
    }
    const text = await res.text();
    let body: RpcResponse<T>;
    try {
      body = JSON.parse(text) as RpcResponse<T>;
    } catch {
      // The SPA fallback (or any HTML page) answered instead of a JSON-RPC
      // proxy — treat it as "no endpoint configured", not a parse error.
      throw new EthRpcError(-32000, ETH_RPC_NOT_CONFIGURED);
    }
    if (body.error) throw new EthRpcError(body.error.code, body.error.message);
    if (body.result === undefined) throw new EthRpcError(-32603, 'Empty Ethereum RPC result');
    return body.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Asserts the endpoint actually serves the selected chain. */
export async function assertEthChain(chain: EthChain = getEthChain()): Promise<void> {
  const id = Number(BigInt(await ethRpc<string>('eth_chainId')));
  if (id !== chain.chainId) {
    throw new EthRpcError(
      -32000,
      `RPC serves chain ${id}, expected ${chain.chainId} (${chain.name})`
    );
  }
}
