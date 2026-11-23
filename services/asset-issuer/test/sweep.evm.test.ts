import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetConfig } from '../src/config.js';
import { deriveDepositAddress } from '../src/depositAddress.js';
import { LocalSweepSigner } from '../src/signers.js';
import { MemoryStore } from '../src/store.js';
import { runSweep } from '../src/sweep.evm.js';

/** BIP32 test vector 1, m/0'/1. Non-hardened index 2 is the allocated address. */
const XPUB = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';
const XPRV = 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs';
const OMNIBUS = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const asset: AssetConfig = {
  assetId: 'usdt',
  symbol: 'USDT',
  depositKind: 'evm',
  depositAddressMode: 'per-user',
  contract: CONTRACT,
  custodyAddress: OMNIBUS,
  l1TokenId: 'token',
  externalDecimals: 6,
  l1Decimals: 6,
  maxSupplyRaw: 10n ** 18n,
  maxMintRaw: 10n ** 12n,
  enabled: true,
};

const replies: Record<string, unknown> = {
  eth_chainId: '0x1',
  eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
  eth_maxPriorityFeePerGas: '0x3b9aca00',
  eth_call: '0x5f5e100', // 100 USDT
  eth_getBalance: '0x16345785d8a0000', // 0.1 ETH
  eth_estimateGas: '0xc350', // 50,000
  eth_getTransactionCount: '0x0',
  eth_sendRawTransaction: '0xfeed',
};

let store: MemoryStore;
let bodies: Array<{ method: string; params: unknown[] }>;

function mockFetch() {
  return (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: unknown[] };
    bodies.push(body);
    if (!(body.method in replies)) throw new Error(`unexpected RPC ${body.method}`);
    return { ok: true, json: async () => ({ result: replies[body.method] }) };
  }) as unknown as typeof fetch;
}

const account = () => deriveDepositAddress(XPUB, '', 2).toLowerCase();

beforeEach(async () => {
  store = new MemoryStore();
  bodies = [];
  await store.putDepositAddress({
    assetId: 'usdt',
    account: 'l1-1',
    address: account(),
    addressIndex: 2,
    chain: 'ethereum',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
});

const run = (over: Record<string, unknown> = {}) => runSweep({
  store,
  assets: [asset],
  rpcUrl: 'http://rpc.test',
  minTokenRaw: 50_000000n,
  nativeReserveWei: 0n,
  gasLimit: 65_000n,
  live: false,
  fetchImpl: mockFetch(),
  ...over,
});

const localSigner = () => new LocalSweepSigner(XPRV, '');

describe('EVM sweeper', () => {
  it('plans a balance above the threshold and reads the address set', async () => {
    const result = await run();
    expect(result.live).toBe(false);
    expect(result.assets[0]!.jobs).toEqual([{
      address: account(),
      account: 'l1-1',
      amountRaw: '100000000',
      gasLimit: '60000',
    }]);
    expect(result.assets[0]!.sent).toEqual([]);
  });

  it('skips a balance below the minimum without signing', async () => {
    const result = await run({ minTokenRaw: 200_000000n });
    expect(result.assets[0]!.jobs).toEqual([]);
    expect(result.assets[0]!.skipped[0]?.reason).toBe('below-min');
    expect(bodies.some((b) => b.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('refuses a live run without a signing key', async () => {
    await expect(run({ live: true })).rejects.toThrow(/requires a signer/);
  });

  it('signs and broadcasts a type-2 transfer when the key matches the allocation', async () => {
    const result = await run({ live: true, signer: localSigner() });

    expect(result.assets[0]!.sent).toEqual([{
      address: account(),
      txHash: '0xfeed',
      amountRaw: '100000000',
    }]);
    expect(result.assets[0]!.failed).toEqual([]);

    const send = bodies.find((b) => b.method === 'eth_sendRawTransaction');
    expect(String(send?.params[0])).toMatch(/^0x02/);
  });

  it('aborts before signing when the key does not control the address', async () => {
    const isolated = new MemoryStore();
    await isolated.putDepositAddress({
      assetId: 'usdt',
      account: 'l1-2',
      address: '0x9999999999999999999999999999999999999999',
      addressIndex: 3,
      chain: 'ethereum',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await run({ store: isolated, live: true, signer: localSigner() });
    expect(bodies.some((b) => b.method === 'eth_sendRawTransaction')).toBe(false);
    expect(result.assets[0]!.failed.map((f) => f.error).join(' ')).toMatch(/not requested address|does not control/);
  });
});
