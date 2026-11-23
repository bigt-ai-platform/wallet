import { describe, expect, it } from 'vitest';
import type { AssetConfig } from '../src/config.js';
import { EvmChainClient, TRANSFER_TOPIC, padAddress } from '../src/chain.evm.js';

const USER = '0x2222222222222222222222222222222222222222';
const CUSTODY = '0x1111111111111111111111111111111111111111';
const EXCHANGE = '0x3333333333333333333333333333333333333333';
const SELF = '0x4444444444444444444444444444444444444444';

const asset: AssetConfig = {
  assetId: 'usdt',
  symbol: 'USDT',
  depositKind: 'evm',
  depositAddressMode: 'per-user',
  contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  custodyAddress: CUSTODY,
  externalDecimals: 6,
  l1Decimals: 6,
  maxSupplyRaw: 10n ** 18n,
  maxMintRaw: 10n ** 12n,
  enabled: true,
};

function log(to: string, from: string, value: bigint, hash: string, logIndex = 0) {
  return {
    address: asset.contract!,
    topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: '0x10',
    transactionHash: hash,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

function client(logs: unknown[], bodies: unknown[] = []) {
  return new EvmChainClient({
    rpcUrl: 'http://rpc.test',
    assets: [asset],
    depositAddresses: async () => [{ address: USER, account: 'l1-user' }],
    // shared-custody fallback: the sender is the account (an explicit mapping
    // in production; identity here would credit the exchange hot wallet).
    mapAccount: (from) => (from.toLowerCase() === SELF ? undefined : `sender:${from.toLowerCase()}`),
    fetchImpl: (async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? '{}'));
      return { ok: true, json: async () => ({ result: logs }) };
    }) as unknown as typeof fetch,
  });
}

describe('EVM deposit scanning with per-user addresses', () => {
  it('attributes a transfer by the allocated address, not the sender', async () => {
    const observations = await client([log(USER, EXCHANGE, 100_000_000n, '0xAAA')]).deposits(16);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      assetId: 'usdt',
      account: 'l1-user',
      externalRaw: '100000000',
      chain: 'ethereum',
      txHash: '0xAAA',
      logIndex: 0,
      blockNumber: 16,
    });
  });

  it('watches every allocated address plus the shared custody address', async () => {
    const bodies: unknown[] = [];
    const scan = client([], bodies);
    await scan.deposits(16);
    const call = bodies[0] as { method: string; params: Array<{ topics: unknown[] }> };
    expect(call.method).toBe('eth_getLogs');
    expect(call.params[0]!.topics[2]).toEqual([padAddress(USER), padAddress(CUSTODY)]);
  });

  it('falls back to the shared custody address and its sender mapping', async () => {
    const observations = await client([
      log(CUSTODY, EXCHANGE, 5n, '0xBBB', 1),
      // an unknown sender is skipped rather than credited to a stranger
      log(CUSTODY, SELF, 7n, '0xCCC', 2),
    ]).deposits(16);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      account: `sender:${EXCHANGE.toLowerCase()}`,
      txHash: '0xBBB',
      logIndex: 1,
    });
  });

  it('re-verifies a deposit receipt, log index, amount, recipient and finality', async () => {
    const receipt = {
      status: '0x1',
      blockNumber: '0x10',
      logs: [log(USER, EXCHANGE, 100_000_000n, '0xAAA')],
    };
    const verify = new EvmChainClient({
      rpcUrl: 'http://rpc.test',
      assets: [asset],
      depositAddresses: async () => [{ address: USER, account: 'l1-user' }],
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? '{}') as { method: string };
        if (body.method === 'eth_getTransactionReceipt') {
          return { ok: true, json: async () => ({ result: receipt }) };
        }
        if (body.method === 'eth_getBlockByNumber') {
          return { ok: true, json: async () => ({ result: { number: '0x64' } }) };
        }
        throw new Error(`unexpected RPC ${body.method}`);
      }) as unknown as typeof fetch,
    });

    const operation = {
      id: 'op',
      kind: 'deposit',
      assetId: 'usdt',
      account: 'l1-user',
      amountRaw: '100000000',
      l1AmountRaw: '100000000',
      status: 'pending',
      ref: { chain: 'ethereum', txHash: '0xAAA', logIndex: 0 },
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as const;

    expect(await verify.verifyDeposit(operation, asset)).toBe(true);
    expect(await verify.verifyDeposit({ ...operation, amountRaw: '1' }, asset)).toBe(false);
    expect(await verify.verifyDeposit({ ...operation, account: 'someone-else' }, asset)).toBe(false);
  });

  it('skips an asset with no addresses at all', async () => {
    const bare = new EvmChainClient({
      rpcUrl: 'http://rpc.test',
      assets: [{ ...asset, custodyAddress: undefined }],
      depositAddresses: async () => [],
      fetchImpl: (async () => {
        throw new Error('must not call the RPC');
      }) as unknown as typeof fetch,
    });
    expect(await bare.deposits(0)).toEqual([]);
  });
});
