/**
 * Real-EVM integration test for the Ethereum signer and ERC-20 codec.
 *
 * Runs only when `ETH_INTEGRATION_RPC` points at a dev chain (see
 * `e2e/eth-integration.sh`, which starts anvil in docker):
 *
 *   ETH_INTEGRATION_RPC=http://127.0.0.1:18545 npx vitest run \
 *     sources/lib/eth/__tests__/integration.test.ts
 *
 * The unit tests prove our EIP-1559 payload recovers to the right signer; this
 * suite proves a real node *accepts* it: it funds the test key, sends a signed
 * native transfer and a signed ERC-20 `transfer`, checks balances/receipts and
 * the `Transfer` log query the deposit-history scan uses.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { signEip1559 } from '../tx';
import { ERC20_SELECTORS, decodeUint, encodeBalanceOf, encodeTransfer, uintWord } from '../abi';
import { addressFromPrivateKey, hexToBytes, stripHexPrefix } from '../address';

const RPC = process.env.ETH_INTEGRATION_RPC;
const suite = RPC ? describe : describe.skip;

const PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ACCOUNT = addressFromPrivateKey(PRIVATE_KEY);
const RECIPIENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const GWEI = 1_000_000_000n;

const TOKEN_CHAIN_NOTE = 'anvil-deployed TestToken (e2e/fixtures/eth-test-token.bin)';

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const q = (value: bigint | number): string => `0x${BigInt(value).toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Receipt {
  status: string;
  transactionHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  blockNumber: string;
  contractAddress?: string | null;
}

async function waitReceipt(hash: string): Promise<Receipt> {
  for (let i = 0; i < 120; i++) {
    const receipt = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await sleep(250);
  }
  throw new Error(`no receipt for ${hash}`);
}

async function balances(address: string): Promise<bigint> {
  return BigInt(await rpc<string>('eth_getBalance', [address, 'latest']));
}

async function tokenBalance(token: string, owner: string): Promise<bigint> {
  const data = await rpc<string>('eth_call', [
    { to: token, data: encodeBalanceOf(owner) },
    'latest',
  ]);
  return decodeUint(data);
}

/** Native transfer built and signed entirely by the wallet code. */
async function sendNative(to: string, value: bigint, chainId: bigint, gasPrice: bigint) {
  const nonce = BigInt(await rpc<string>('eth_getTransactionCount', [ACCOUNT, 'pending']));
  const gasLimit = BigInt(await rpc<string>('eth_estimateGas', [{ from: ACCOUNT, to, value: q(value) }]));
  const signed = signEip1559(
    {
      chainId,
      nonce,
      maxPriorityFeePerGas: GWEI,
      maxFeePerGas: gasPrice * 2n,
      gasLimit,
      to,
      value,
    },
    hexToBytes(stripHexPrefix(PRIVATE_KEY))
  );
  const hash = await rpc<string>('eth_sendRawTransaction', [signed.raw]);
  return { hash, signed };
}

suite('Ethereum signer against a real EVM (anvil)', () => {
  let chainId: bigint;
  let gasPrice: bigint;

  beforeAll(async () => {
    chainId = BigInt(await rpc<string>('eth_chainId'));
    gasPrice = BigInt(await rpc<string>('eth_gasPrice'));
    // Dev-chain only helper: fund the test key from thin air.
    await rpc('anvil_setBalance', [ACCOUNT, q(10n ** 19n)]); // 10 ETH
  }, 30000);

  it('broadcasts a signed native transfer and pays exactly value + gasUsed×price', async () => {
    const value = 10n ** 16n; // 0.01 ETH
    const before = await balances(ACCOUNT);
    const beforeNonce = BigInt(await rpc<string>('eth_getTransactionCount', [ACCOUNT, 'latest']));

    const { hash } = await sendNative(RECIPIENT, value, chainId, gasPrice);
    const receipt = await waitReceipt(hash);

    expect(receipt.status).toBe('0x1');
    const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    const after = await balances(ACCOUNT);
    expect(before - after).toBe(value + fee);
    expect(await balances(RECIPIENT)).toBeGreaterThanOrEqual(value);

    const nonce = BigInt(await rpc<string>('eth_getTransactionCount', [ACCOUNT, 'latest']));
    expect(nonce).toBe(beforeNonce + 1n);
  }, 60000);

  it('transfers an ERC-20 token and exposes the Transfer log the deposit scan reads', async () => {
    // Deploy the fixture token with the node's unlocked account (contract
    // creation is not a wallet feature; the fixture's bytecode is compiled
    // from the minimal source in the test description).
    const [deployer] = await rpc<string[]>('eth_accounts');
    const bytecode = fs
      .readFileSync(path.join(__dirname, '../../../../../e2e/fixtures/eth-test-token.bin'), 'utf8')
      .trim();
    const supply = 1_000_000_000n; // 1000 tokens at 6 decimals
    const deployHash = await rpc<string>('eth_sendTransaction', [
      {
        from: deployer,
        data: `0x${bytecode}${Buffer.from(uintWord(supply)).toString('hex')}`,
        gas: q(2_000_000),
      },
    ]);
    const deployed = await waitReceipt(deployHash);
    const token = deployed.contractAddress!;
    expect(token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await tokenBalance(token, deployer)).toBe(supply);

    // Fund our account from the deployer (node-signed) so the wallet can send.
    const fund = 500_000n;
    const fundHash = await rpc<string>('eth_sendTransaction', [
      { from: deployer, to: token, data: encodeTransfer(ACCOUNT, fund), gas: q(200_000) },
    ]);
    expect((await waitReceipt(fundHash)).status).toBe('0x1');
    expect(await tokenBalance(token, ACCOUNT)).toBe(fund);

    // Wallet-signed ERC-20 transfer.
    const amount = 123_456n;
    const nonce = BigInt(await rpc<string>('eth_getTransactionCount', [ACCOUNT, 'pending']));
    const gasLimit = BigInt(
      await rpc<string>('eth_estimateGas', [
        { from: ACCOUNT, to: token, data: encodeTransfer(RECIPIENT, amount) },
      ])
    );
    const signed = signEip1559(
      {
        chainId,
        nonce,
        maxPriorityFeePerGas: GWEI,
        maxFeePerGas: gasPrice * 2n,
        gasLimit,
        to: token,
        value: 0n,
        data: encodeTransfer(RECIPIENT, amount),
      },
      hexToBytes(stripHexPrefix(PRIVATE_KEY))
    );
    const hash = await rpc<string>('eth_sendRawTransaction', [signed.raw]);
    expect((await waitReceipt(hash)).status).toBe('0x1');
    expect(await tokenBalance(token, RECIPIENT)).toBe(amount);
    expect(await tokenBalance(token, ACCOUNT)).toBe(fund - amount);

    // The same query shape getIncomingTokenTransfers uses.
    const logs = await rpc<Array<{ data: string; topics: string[]; blockNumber: string }>>(
      'eth_getLogs',
      [
        {
          fromBlock: q(deployed.blockNumber),
          toBlock: 'latest',
          address: token,
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            null,
            `0x${'0'.repeat(24)}${stripHexPrefix(RECIPIENT).toLowerCase()}`,
          ],
        },
      ]
    );
    const ours = logs.filter((l) => decodeUint(l.data) === amount);
    expect(ours.length).toBe(1);
    expect(ours[0].topics[0]).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    );

    // Sanity: the selector we encode matches the real contract's ABI.
    expect(ERC20_SELECTORS.transfer).toBe('0xa9059cbb');
    expect(TOKEN_CHAIN_NOTE).toContain('anvil');
  }, 60000);
});
