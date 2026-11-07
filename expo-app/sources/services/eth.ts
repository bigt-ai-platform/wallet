/**
 * Ethereum account / balances / transfers.
 *
 * The account is derived from the wallet's legacy EC key (`keyType === 'EC'`);
 * signing happens on device and only the signed raw transaction is broadcast.
 * Nothing here sends the private key over the network.
 */

import { ethRpc, getEthChain, getEthTokens, assertEthChain } from './ethRpc';
import {
  addressFromPrivateKey,
  requireAddress,
  sameAddress,
  isAddress,
  hexToBytes,
  stripHexPrefix,
} from '@/lib/eth/address';
import { decodeString, decodeUint, encodeBalanceOf, encodeTransfer, ERC20_SELECTORS } from '@/lib/eth/abi';
import { signEip1559, type Eip1559TxParams } from '@/lib/eth/tx';
import type { EthChain, EthToken } from '@/lib/eth/chains';

/** Native coin as a token-like asset (18 decimals). */
export const ETH_DECIMALS = 18;

export interface EthAsset {
  /** 'native' for the chain coin, otherwise the ERC-20 contract. */
  key: string;
  symbol: string;
  decimals: number;
  token?: EthToken;
}

export interface EthAssetBalance {
  asset: EthAsset;
  raw: bigint;
}

export interface EthReceipt {
  status: 'success' | 'failed' | 'pending';
  blockNumber?: number;
  transactionHash: string;
}

export interface EthFeeData {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

function toQuantity(value: bigint | number): string {
  const big = typeof value === 'number' ? BigInt(value) : value;
  return `0x${big.toString(16)}`;
}

function fromQuantity(value: string | null | undefined): bigint {
  if (!value || value === '0x') return 0n;
  return BigInt(value);
}

function chainOr(chain?: EthChain): EthChain {
  return chain ?? getEthChain();
}

/** Checksummed Ethereum account for the wallet's EC private key. */
export function accountFromPrivateKey(privateKeyHex: string): string {
  return addressFromPrivateKey(privateKeyHex);
}

export function nativeAsset(chain: EthChain): EthAsset {
  return { key: 'native', symbol: chain.nativeSymbol, decimals: ETH_DECIMALS };
}

export function tokenAsset(token: EthToken): EthAsset {
  return { key: token.address.toLowerCase(), symbol: token.symbol, decimals: token.decimals, token };
}

export function assetsOf(chain: EthChain): EthAsset[] {
  return [nativeAsset(chain), ...getEthTokens(chain).map(tokenAsset)];
}

export async function getNativeBalance(address: string, chain?: EthChain): Promise<bigint> {
  const c = chainOr(chain);
  return fromQuantity(await ethRpc<string>('eth_getBalance', [requireAddress(address), 'latest']));
}

export async function getErc20Balance(
  tokenAddress: string,
  address: string,
  chain?: EthChain
): Promise<bigint> {
  chainOr(chain);
  const data = await ethRpc<string>('eth_call', [
    { to: requireAddress(tokenAddress), data: encodeBalanceOf(requireAddress(address)) },
    'latest',
  ]);
  return decodeUint(data);
}

/** Reads decimals + symbol for a contract (custom token add flow). */
export async function getErc20Meta(tokenAddress: string, chain?: EthChain): Promise<EthToken> {
  const c = chainOr(chain);
  const address = requireAddress(tokenAddress);
  const [decimalsRaw, symbolRaw] = await Promise.all([
    ethRpc<string>('eth_call', [{ to: address, data: ERC20_SELECTORS.decimals }, 'latest']).catch(
      () => '0x'
    ),
    ethRpc<string>('eth_call', [{ to: address, data: ERC20_SELECTORS.symbol }, 'latest']).catch(
      () => '0x'
    ),
  ]);
  const decimals = Number(decodeUint(decimalsRaw));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Not an ERC-20 contract');
  }
  return {
    address,
    symbol: decodeString(symbolRaw) || `${address.slice(0, 6)}…`,
    decimals,
  };
}

/** Balances for the native coin and every configured token (parallel). */
export async function loadBalances(
  address: string,
  chain?: EthChain
): Promise<EthAssetBalance[]> {
  const c = chainOr(chain);
  await assertEthChain(c);
  const owned = requireAddress(address);
  const assets = assetsOf(c);
  const results = await Promise.all(
    assets.map(async (asset) => {
      try {
        const raw =
          asset.key === 'native'
            ? await getNativeBalance(owned, c)
            : await getErc20Balance(asset.token!.address, owned, c);
        return { asset, raw };
      } catch {
        return { asset, raw: 0n };
      }
    })
  );
  return results;
}

/** EIP-1559 fees: base fee from the latest block plus a priority fee. */
export async function getFeeData(chain?: EthChain): Promise<EthFeeData> {
  chainOr(chain);
  try {
    const history = await ethRpc<{
      baseFeePerGas?: string[];
      reward?: string[][];
    }>('eth_feeHistory', ['0x5', 'latest', [50]]);
    const baseFees = (history.baseFeePerGas ?? []).map(fromQuantity);
    const base = baseFees.length ? baseFees[baseFees.length - 1] : 0n;
    const rewards = (history.reward ?? []).map((r) => fromQuantity(r?.[0])).filter((v) => v > 0n);
    const priority = rewards.length
      ? rewards.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(rewards.length / 2)]
      : 1_000_000_000n;
    if (base > 0n) {
      return { maxPriorityFeePerGas: priority, maxFeePerGas: base * 2n + priority };
    }
  } catch {
    /* fall back to eth_gasPrice */
  }
  const gasPrice = fromQuantity(await ethRpc<string>('eth_gasPrice'));
  const price = gasPrice > 0n ? gasPrice : 20_000_000_000n;
  return { maxPriorityFeePerGas: price, maxFeePerGas: price };
}

export interface TransferRequest {
  privateKeyHex: string;
  to: string;
  /** Smallest units of the asset. */
  amount: bigint;
  chain?: EthChain;
  /** Estimate multiplied up for safety; defaults to 1.2x with a floor. */
  gasLimitOverride?: bigint;
}

export interface PreparedTransfer {
  from: string;
  to: string;
  asset: EthAsset;
  amount: bigint;
  gasLimit: bigint;
  fee: EthFeeData;
  /** gasLimit × maxFeePerGas, in the native coin's smallest units. */
  maxFeeWei: bigint;
  data: string;
}

async function prepare(
  req: TransferRequest,
  asset: EthAsset,
  data: string,
  value: bigint,
  floorGas: bigint
): Promise<PreparedTransfer> {
  const chain = chainOr(req.chain);
  const from = accountFromPrivateKey(req.privateKeyHex);
  const to = requireAddress(req.to);
  if (!isAddress(to)) throw new Error('Invalid recipient address');
  if (sameAddress(from, to)) throw new Error('Cannot send to your own address');

  const fee = await getFeeData(chain);
  const estimate = await ethRpc<string>('eth_estimateGas', [
    {
      from,
      to: asset.key === 'native' ? to : asset.token!.address,
      value: toQuantity(value),
      data: data || '0x',
    },
  ]).catch(() => '0x0');
  const estimated = fromQuantity(estimate);
  const gasLimit =
    req.gasLimitOverride ?? (estimated > 0n ? (estimated * 12n) / 10n : floorGas);
  return {
    from,
    to,
    asset,
    amount: req.amount,
    gasLimit,
    fee,
    maxFeeWei: gasLimit * fee.maxFeePerGas,
    data,
  };
}

export async function prepareNativeTransfer(req: TransferRequest): Promise<PreparedTransfer> {
  const chain = chainOr(req.chain);
  if (req.amount <= 0n) throw new Error('Amount must be greater than zero');
  return prepare(req, nativeAsset(chain), '', req.amount, 21000n);
}

export async function prepareTokenTransfer(req: TransferRequest & { token: EthToken }): Promise<PreparedTransfer> {
  if (req.amount <= 0n) throw new Error('Amount must be greater than zero');
  const asset = tokenAsset(req.token);
  return prepare(
    req,
    asset,
    encodeTransfer(requireAddress(req.to), req.amount),
    0n,
    65000n
  );
}

async function broadcast(prepared: PreparedTransfer, privateKeyHex: string, chain: EthChain): Promise<{ hash: string; from: string }> {
  const nonce = fromQuantity(
    await ethRpc<string>('eth_getTransactionCount', [prepared.from, 'pending'])
  );
  const tx: Eip1559TxParams = {
    chainId: BigInt(chain.chainId),
    nonce,
    maxPriorityFeePerGas: prepared.fee.maxPriorityFeePerGas,
    maxFeePerGas: prepared.fee.maxFeePerGas,
    gasLimit: prepared.gasLimit,
    to: prepared.asset.key === 'native' ? prepared.to : prepared.asset.token!.address,
    value: prepared.asset.key === 'native' ? prepared.amount : 0n,
    data: prepared.data,
  };
  const signed = signEip1559(tx, hexToBytes(stripHexPrefix(privateKeyHex)));
  const hash = await ethRpc<string>('eth_sendRawTransaction', [signed.raw]);
  return { hash, from: signed.from };
}

export async function sendNativeTransfer(req: TransferRequest): Promise<{ hash: string; from: string }> {
  const chain = chainOr(req.chain);
  await assertEthChain(chain);
  const prepared = await prepareNativeTransfer({ ...req, chain });
  const native = await getNativeBalance(prepared.from, chain);
  if (req.amount + prepared.maxFeeWei > native) throw new Error('Insufficient balance for amount + fee');
  return broadcast(prepared, req.privateKeyHex, chain);
}

export async function sendTokenTransfer(
  req: TransferRequest & { token: EthToken }
): Promise<{ hash: string; from: string }> {
  const chain = chainOr(req.chain);
  await assertEthChain(chain);
  const prepared = await prepareTokenTransfer({ ...req, chain });
  const gasBalance = await getNativeBalance(prepared.from, chain);
  if (prepared.maxFeeWei > gasBalance) throw new Error('Insufficient native balance for the network fee');
  const tokenBalance = await getErc20Balance(req.token.address, prepared.from, chain);
  if (req.amount > tokenBalance) throw new Error('Insufficient token balance');
  return broadcast(prepared, req.privateKeyHex, chain);
}

/** Receipt status, or null while the transaction is still pending. */
export async function getTransactionReceipt(
  hash: string,
  chain?: EthChain
): Promise<EthReceipt | null> {
  chainOr(chain);
  const receipt = await ethRpc<{
    status?: string;
    blockNumber?: string;
    transactionHash: string;
  } | null>('eth_getTransactionReceipt', [hash]);
  if (!receipt) return null;
  return {
    status: fromQuantity(receipt.status) === 1n ? 'success' : 'failed',
    blockNumber: receipt.blockNumber ? Number(fromQuantity(receipt.blockNumber)) : undefined,
    transactionHash: receipt.transactionHash,
  };
}

/** Polls the receipt; resolves null on timeout (still pending). */
export async function waitForReceipt(
  hash: string,
  chain?: EthChain,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<EthReceipt | null> {
  const attempts = opts.attempts ?? 30;
  const interval = opts.intervalMs ?? 4000;
  for (let i = 0; i < attempts; i++) {
    try {
      const receipt = await getTransactionReceipt(hash, chain);
      if (receipt) return receipt;
    } catch {
      /* transient RPC error — keep polling */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

