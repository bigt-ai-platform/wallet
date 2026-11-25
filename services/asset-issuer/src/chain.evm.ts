/**
 * EVM deposit source over plain JSON-RPC.
 *
 * Reads ERC-20 `Transfer` logs into the configured custody address and the
 * `finalized` block number. No SDK: two eth_* calls and a topic decode, so it
 * runs against any provider or our own node.
 *
 * Deliberately **not** implemented here:
 *
 * - **Native ETH deposits** — a JSON-RPC node cannot list an address's native
 *   transfers; that needs the address index the wallet already uses
 *   (`/ethindex`). Wire it as a second `DepositSource` when the issuer needs it.
 * - **L1 redemptions** — those live on `L1-order`, not EVM; `redemptions()`
 *   returns an empty list and the caller must supply the L1 source.
 * - **Account mapping** — the external sender/recipient is not an L1 address.
 *   `mapAccount` is the seam where the service resolves it; when it returns
 *   undefined the deposit is skipped rather than credited to a stranger.
 */

import type { AssetConfig } from './config.js';
import { isFinalized, type Operation } from './domain.js';
import type { ChainClient, DepositObservation, RedemptionObservation } from './watcher.js';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One allocated per-user deposit address and the L1 account it credits. */
export interface DepositAddressEntry {
  address: string;
  account: string;
}

export interface EvmChainClientOptions {
  rpcUrl: string;
  /** Chain label recorded on operations, e.g. `ethereum`. */
  chain?: string;
  assets: AssetConfig[];
  /**
   * Per-user addresses allocated for an asset. When omitted only
   * `asset.custodyAddress` (shared custody) is watched.
   */
  depositAddresses?: (asset: AssetConfig) => Promise<DepositAddressEntry[]>;
  /** Map an external address to the L1 account to credit (shared-address rail). */
  mapAccount?: (externalAddress: string, asset: AssetConfig) => string | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Inclusive block range per `eth_getLogs` call (providers cap this). */
  logChunk?: number;
  /** Addresses per `topics[2]` filter; providers cap the array size. */
  addressBatch?: number;
}

export class EvmChainClient implements ChainClient {
  private readonly rpcUrl: string;
  private readonly chain: string;
  private readonly assets: AssetConfig[];
  private readonly mapAccount: (external: string, asset: AssetConfig) => string | undefined;
  private readonly depositAddresses: (asset: AssetConfig) => Promise<DepositAddressEntry[]>;
  private readonly fetchImpl: typeof fetch;
  private readonly logChunk: number;
  private readonly addressBatch: number;
  private rpcId = 0;

  constructor(options: EvmChainClientOptions) {
    this.rpcUrl = options.rpcUrl;
    this.chain = options.chain ?? 'ethereum';
    this.assets = options.assets;
    this.mapAccount = options.mapAccount ?? ((external) => external);
    this.depositAddresses = options.depositAddresses ?? (async () => []);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logChunk = Math.max(1, options.logChunk ?? 2000);
    this.addressBatch = Math.max(1, options.addressBatch ?? 100);
  }

  /** Inclusive block range one `deposits(fromBlock)` call scans. */
  get depositWindow(): number {
    return this.logChunk;
  }

  async finalizedBlock(_chain: string): Promise<number> {
    const block = await this.rpc<{ number: string } | null>('eth_getBlockByNumber', ['finalized', false]);
    if (!block?.number) {
      // Never fall back to 'latest': minting on confirmations is the exact bug
      // the finality gate exists to prevent.
      throw new Error('RPC did not return a finalized block; refusing to treat latest as final');
    }
    return Number.parseInt(block.number, 16);
  }

  async deposits(fromBlock: number, toBlock?: number): Promise<DepositObservation[]> {
    const out: DepositObservation[] = [];
    const end = toBlock ?? fromBlock + this.logChunk - 1;

    for (const asset of this.assets) {
      if (!asset.enabled || !asset.contract) continue;

      // Attribution: a per-user address maps to its L1 account; the shared
      // custody address (if configured) falls back to `mapAccount(from)`.
      const allocated = await this.depositAddresses(asset);
      const byAddress = new Map<string, string>();
      for (const entry of allocated) byAddress.set(entry.address.toLowerCase(), entry.account);

      const watch = new Set<string>(byAddress.keys());
      if (asset.custodyAddress) watch.add(asset.custodyAddress.toLowerCase());
      if (watch.size === 0) continue;

      const addresses = [...watch];
      for (let offset = 0; offset < addresses.length; offset += this.addressBatch) {
        const batch = addresses.slice(offset, offset + this.addressBatch);
        const topic = batch.length === 1 ? padAddress(batch[0]!) : batch.map((address) => padAddress(address));
        const logs = await this.rpc<RawLog[]>('eth_getLogs', [{
          address: asset.contract,
          fromBlock: toHex(fromBlock),
          toBlock: toHex(end),
          topics: [TRANSFER_TOPIC, null, topic],
        }]);
        for (const log of logs ?? []) {
          const observation = this.toObservation(asset, log, byAddress);
          if (observation) out.push(observation);
        }
      }
      // One range per call: the caller advances its own cursor using the
      // finalized head, so a long backfill is a caller loop.
    }
    return out;
  }

  /** The L1 redemption source is separate; this client never returns any. */
  async redemptions(_fromBlock: number): Promise<RedemptionObservation[]> {
    return [];
  }

  /**
   * Re-verify an observed deposit at execution time. The DB row is not proof:
   * the receipt must still be successful, the matching log must still be at
   * the recorded index, the recipient must map to the same account, and the
   * block must be finalized.
   */
  async verifyDeposit(operation: Operation, asset: AssetConfig): Promise<boolean> {
    if (!operation.ref || !asset.contract) return false;
    if (operation.ref.chain !== this.chain) return false;

    const receipt = await this.rpc<RawReceipt | null>('eth_getTransactionReceipt', [operation.ref.txHash]);
    if (!receipt || receipt.status !== '0x1' || !receipt.blockNumber) return false;

    const blockNumber = Number.parseInt(receipt.blockNumber, 16);
    if (!isFinalized(await this.finalizedBlock(this.chain), blockNumber)) return false;

    const log = (receipt.logs ?? []).find((candidate) => (
      candidate.address?.toLowerCase() === asset.contract!.toLowerCase()
      && candidate.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC
      && Number.parseInt(candidate.logIndex, 16) === operation.ref!.logIndex
    ));
    if (!log || !log.topics || log.topics.length < 3) return false;

    const from = unpadAddress(log.topics[1]!);
    const to = unpadAddress(log.topics[2]!);
    if (!from || !to) return false;
    if (BigInt(log.data).toString() !== operation.amountRaw) return false;

    const byAddress = new Map<string, string>();
    for (const entry of await this.depositAddresses(asset)) {
      byAddress.set(entry.address.toLowerCase(), entry.account);
    }
    const account = byAddress.get(to.toLowerCase()) ?? this.mapAccount(from, asset);
    return account === operation.account;
  }

  private toObservation(
    asset: AssetConfig,
    log: RawLog,
    byAddress: Map<string, string>,
  ): DepositObservation | undefined {
    if (!log.topics || log.topics.length < 3) return undefined;
    if (log.topics[0]!.toLowerCase() !== TRANSFER_TOPIC) return undefined;
    const from = unpadAddress(log.topics[1]!);
    const to = unpadAddress(log.topics[2]!);
    if (!from || !to) return undefined;
    const value = BigInt(log.data);
    if (value <= 0n) return undefined;
    // The destination address is the attribution key when it was allocated to
    // a user; only the shared custody address falls back to the sender.
    const account = byAddress.get(to.toLowerCase()) ?? this.mapAccount(from, asset);
    if (!account) return undefined;
    return {
      assetId: asset.assetId,
      account,
      externalRaw: value.toString(),
      chain: this.chain,
      txHash: log.transactionHash,
      logIndex: Number.parseInt(log.logIndex, 16),
      blockNumber: Number.parseInt(log.blockNumber, 16),
    };
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? 'error'}`);
    if (body.result === undefined) throw new Error(`RPC ${method}: empty result`);
    return body.result;
  }
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

interface RawReceipt {
  status?: string;
  blockNumber?: string;
  logs?: RawLog[];
}

/** 20-byte address → 32-byte topic word. */
export function padAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not an address: ${address}`);
  return `0x${'0'.repeat(24)}${clean}`;
}

/** 32-byte topic word → 20-byte address, or undefined when malformed. */
export function unpadAddress(topic: string): string | undefined {
  const clean = topic.toLowerCase().replace(/^0x/, '');
  if (clean.length !== 64) return undefined;
  return `0x${clean.slice(24)}`;
}

function toHex(value: number): string {
  return `0x${value.toString(16)}`;
}
