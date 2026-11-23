/**
 * EVM sweeper: consolidate per-user deposit addresses into the omnibus.
 *
 * Two hard gates:
 *   1. `live: false` only plans — nothing is signed (the default).
 *   2. `live: true` needs an xprv (or an HSM/MPC adapter, not in this process)
 *      and verifies that each derived key actually controls the address being
 *      swept before signing anything.
 *
 * The sweep is balance-based and therefore idempotent: a crash after broadcast
 * leaves a lower balance, and the next run plans only what remains.
 */

import type { AssetConfig } from './config.js';
import type { Store } from './store.js';
import {
  bytesToHex,
  erc20TransferData,
  hexToBigInt,
  hexToBytes,
} from './ethTx.js';
import { planSweeps, type SweepCandidate, type SweepSkip } from './sweep.js';
import type { SweepSigner } from './signers.js';

export interface SweepRunOptions {
  store: Store;
  assets: AssetConfig[];
  rpcUrl: string;
  /** Limit to one asset; otherwise every enabled per-user EVM asset. */
  assetId?: string;
  /** Minimum token balance worth a sweep, smallest units. */
  minTokenRaw: bigint;
  /** ETH left behind after gas, wei. */
  nativeReserveWei: bigint;
  /** Fallback gas limit when `eth_estimateGas` fails. */
  gasLimit: bigint;
  /** False = plan only. True requires `signer`. */
  live: boolean;
  /** HSM/MPC signer, or the local xprv signer for testnet/small float. */
  signer?: SweepSigner;
  fetchImpl?: typeof fetch;
}

export interface SweepJobView {
  address: string;
  account: string;
  amountRaw: string;
  gasLimit: string;
}

export interface SweepSentView {
  address: string;
  txHash: string;
  amountRaw: string;
}

export interface SweepFailureView {
  address: string;
  error: string;
}

export interface SweepAssetResult {
  assetId: string;
  omnibus: string;
  maxFeePerGasWei: string;
  jobs: SweepJobView[];
  skipped: SweepSkip[];
  sent: SweepSentView[];
  failed: SweepFailureView[];
  note?: string;
}

export interface SweepRunResult {
  live: boolean;
  assets: SweepAssetResult[];
}

class JsonRpc {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? 'error'}`);
    if (body.result === undefined) throw new Error(`RPC ${method}: empty result`);
    return body.result;
  }
}

function padAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not an address: ${address}`);
  return clean.padStart(64, '0');
}

function balanceOfData(address: string): string {
  return `0x70a08231${padAddress(address)}`;
}

export async function runSweep(options: SweepRunOptions): Promise<SweepRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rpc = new JsonRpc(options.rpcUrl, fetchImpl);

  const selected = options.assets
    .filter((asset) => asset.enabled && asset.depositAddressMode === 'per-user' && !!asset.contract)
    .filter((asset) => !options.assetId || asset.assetId.toLowerCase() === options.assetId.toLowerCase());

  if (options.assetId && selected.length === 0) {
    throw new Error(`asset ${options.assetId} is not an enabled per-user EVM asset`);
  }
  if (selected.length === 0) return { live: options.live, assets: [] };

  const chainId = hexToBigInt(await rpc.call<string>('eth_chainId', []));
  const block = await rpc.call<{ baseFeePerGas?: string } | null>('eth_getBlockByNumber', ['latest', false]);
  const baseFee = block?.baseFeePerGas
    ? hexToBigInt(block.baseFeePerGas)
    : hexToBigInt(await rpc.call<string>('eth_gasPrice', []));
  const tip = await rpc.call<string>('eth_maxPriorityFeePerGas', [])
    .then(hexToBigInt)
    .catch(() => 1_000_000_000n);
  const maxFeePerGas = baseFee * 2n + tip;

  if (options.live && !options.signer) {
    throw new Error('live sweep requires a signer (SWEEP_SIGN_COMMAND or DEPOSIT_XPRV)');
  }

  const results: SweepAssetResult[] = [];

  for (const asset of selected) {
    const omnibus = asset.custodyAddress;
    if (!omnibus) throw new Error(`asset ${asset.assetId} has no custodyAddress to sweep into`);

    const allocations = await options.store.listDepositAddresses(asset.assetId);
    if (allocations.length === 0) {
      results.push({
        assetId: asset.assetId,
        omnibus,
        maxFeePerGasWei: maxFeePerGas.toString(),
        jobs: [],
        skipped: [],
        sent: [],
        failed: [],
        note: 'no allocated deposit addresses',
      });
      continue;
    }

    const candidates: SweepCandidate[] = [];
    const failed: SweepFailureView[] = [];

    for (const allocation of allocations) {
      try {
        const tokenBalanceRaw = hexToBigInt(await rpc.call<string>('eth_call', [{
          to: asset.contract,
          data: balanceOfData(allocation.address),
        }, 'latest']));
        const nativeBalanceWei = hexToBigInt(await rpc.call<string>('eth_getBalance', [allocation.address, 'latest']));

        let gasLimit = options.gasLimit;
        try {
          const estimated = hexToBigInt(await rpc.call<string>('eth_estimateGas', [{
            from: allocation.address,
            to: asset.contract,
            data: bytesToHex(erc20TransferData(omnibus, tokenBalanceRaw > 0n ? tokenBalanceRaw : 1n)),
          }]));
          // 20% headroom, like the wallet's transfer builder.
          gasLimit = (estimated * 12n) / 10n;
        } catch {
          /* keep the configured fallback; the planner may skip for lack of gas */
        }

        candidates.push({
          assetId: asset.assetId,
          account: allocation.account,
          address: allocation.address,
          addressIndex: allocation.addressIndex,
          tokenBalanceRaw,
          nativeBalanceWei,
          gasLimit,
        });
      } catch (error) {
        failed.push({
          address: allocation.address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const plan = planSweeps(candidates, {
      omnibus,
      minTokenRaw: options.minTokenRaw,
      maxFeePerGasWei: maxFeePerGas,
      nativeReserveWei: options.nativeReserveWei,
    });

    const sent: SweepSentView[] = [];

    if (options.live) {
      const signer = options.signer as SweepSigner;
      for (const job of plan.jobs) {
        try {
          const nonce = hexToBigInt(await rpc.call<string>('eth_getTransactionCount', [job.address, 'pending']));
          const signed = await signer.sign({
            address: job.address,
            addressIndex: job.addressIndex,
            chainId: chainId.toString(),
            nonce: nonce.toString(),
            maxPriorityFeePerGas: tip.toString(),
            maxFeePerGas: maxFeePerGas.toString(),
            gasLimit: job.gasLimit.toString(),
            to: asset.contract as string,
            data: bytesToHex(erc20TransferData(omnibus, job.amountRaw)),
          });
          if (signed.signer.toLowerCase() !== job.address.toLowerCase()) {
            throw new Error(`signer ${signed.signer} does not control allocated address ${job.address}`);
          }
          const raw = hexToBytes(signed.rawTransaction);
          if (raw.length === 0 || raw[0] !== 0x02) {
            throw new Error('signer returned a non-type-2 transaction');
          }
          const txHash = await rpc.call<string>('eth_sendRawTransaction', [signed.rawTransaction]);
          sent.push({ address: job.address, txHash, amountRaw: job.amountRaw.toString() });
        } catch (error) {
          failed.push({
            address: job.address,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    results.push({
      assetId: asset.assetId,
      omnibus,
      maxFeePerGasWei: maxFeePerGas.toString(),
      jobs: plan.jobs.map((job) => ({
        address: job.address,
        account: job.account,
        amountRaw: job.amountRaw.toString(),
        gasLimit: job.gasLimit.toString(),
      })),
      skipped: plan.skipped,
      sent,
      failed,
    });
  }

  return { live: options.live, assets: results };
}


