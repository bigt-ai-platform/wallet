import { describe, expect, it } from 'vitest';
import { parseCli, runPass, type Pipeline } from '../src/cli.js';
import { DEFAULT_ASSETS } from '../src/config.js';
import { MemoryStore } from '../src/store.js';
import type { ChainClient } from '../src/watcher.js';

describe('cli parsing', () => {
  it('defaults to one pass on Test with the default assets', () => {
    const options = parseCli([], {});
    expect(options.command).toBe('once');
    expect(options.network).toBe('Test');
    expect(options.fromBlock).toBe(0);
    expect(options.intervalMs).toBe(60000);
    expect(options.live).toBe(false);
    expect(options.assets.map((a) => a.assetId)).toEqual(['hkd', 'usd', 'gold', 'eth']);
  });

  it('reads the adapters and the live switch', () => {
    const options = parseCli(['loop'], {
      ETH_RPC_URL: 'https://rpc.example',
      L1_URL: 'https://ordereu1.bigt-ai.org',
      L1_ISSUER_KEY: 'abcd',
      ALLOW_LIVE_L1: '1',
      FROM_BLOCK: '42',
      INTERVAL_MS: '5000',
      DATABASE_URL: 'postgres://x',
      NETWORK: 'Mainnet',
    });
    expect(options).toMatchObject({
      command: 'loop',
      fromBlock: 42,
      intervalMs: 5000,
      live: true,
      network: 'Mainnet',
      ethRpcUrl: 'https://rpc.example',
      l1Url: 'https://ordereu1.bigt-ai.org',
      databaseUrl: 'postgres://x',
    });
  });

  it('refuses an unknown command', () => {
    expect(() => parseCli(['frobnicate'], {})).toThrow(/unknown command/);
  });

  it('refuses Mainnet without a database', () => {
    expect(() => parseCli(['once'], { NETWORK: 'Mainnet' })).toThrow(/DATABASE_URL/);
  });

  it('refuses an unknown network instead of treating it as Test', () => {
    expect(() => parseCli(['once'], { NETWORK: 'Production' })).toThrow(/NETWORK must be/);
  });

  it('parses sweep settings and defaults to a dry plan', () => {
    const options = parseCli(['sweep'], {
      SWEEP_MIN_RAW: '20000000',
      SWEEP_GAS_LIMIT: '70000',
      SWEEP_NATIVE_RESERVE_WEI: '1000',
      DEPOSIT_XPRV: 'xprv-test',
      DEPOSIT_XPRV_PATH: '0',
      SWEEP_ASSET_ID: 'usdt',
    });
    expect(options.sweep).toMatchObject({
      live: false,
      minTokenRaw: 20_000_000n,
      gasLimit: 70_000n,
      nativeReserveWei: 1_000n,
      xprv: 'xprv-test',
      xprvPath: '0',
      assetId: 'usdt',
    });
  });

  it('requires smallest units for sweep thresholds', () => {
    expect(() => parseCli(['sweep'], { SWEEP_MIN_RAW: '1.5' })).toThrow(/SWEEP_MIN_RAW/);
  });

  it('selects external HSM/MPC commands without a local key', () => {
    const options = parseCli(['loop'], {
      L1_SIGNER: 'command',
      L1_MINT_COMMAND: '/usr/local/bin/l1-mint',
      TREASURY_RELEASE_COMMAND: '/usr/local/bin/treasury-release',
      ALLOW_LIVE_TREASURY: '1',
      SWEEP_SIGN_COMMAND: '/usr/local/bin/sweep-sign',
      SIGNER_TIMEOUT_MS: '15000',
    });
    expect(options).toMatchObject({
      l1Signer: 'command',
      l1MintCommand: '/usr/local/bin/l1-mint',
      treasuryCommand: '/usr/local/bin/treasury-release',
      treasuryLive: true,
      signerTimeoutMs: 15_000,
    });
    expect(options.sweep.signCommand).toBe('/usr/local/bin/sweep-sign');
  });

  it('refuses command mode without a command', () => {
    expect(() => parseCli(['loop'], { L1_SIGNER: 'command' })).toThrow(/L1_MINT_COMMAND/);
    expect(() => parseCli(['loop'], { L1_SIGNER: 'nope' })).toThrow(/L1_SIGNER/);
  });
});

describe('one pass', () => {
  function pipeline(): Pipeline {
    return {
      store: new MemoryStore(),
      assets: DEFAULT_ASSETS,
      fromBlock: 0,
      live: false,
      minter: { mint: async () => { throw new Error('not configured'); } },
      treasury: { release: async () => { throw new Error('not configured'); } },
      close: async () => {},
    };
  }

  it('does nothing (and does not crash) with no chain and no work', async () => {
    const summary = await runPass(pipeline());
    expect(summary).toEqual({
      deposits: null,
      redemptions: null,
      executed: { completed: 0, failed: 0, skipped: 0 },
      attestations: 0,
      breaches: 0,
    });
  });

  it('publishes attestations for each reserve on the pass', async () => {
    const p = pipeline();
    await p.store.putReserve({ assetId: 'hkd', reserveRaw: 10n, supplyRaw: 10n, dustRaw: 0n });
    const summary = await runPass(p);
    expect(summary.attestations).toBe(1);
    expect(summary.breaches).toBe(0);
    expect((await p.store.latestAttestation('hkd'))?.version).toBe(1);
  });

  it('reports a solvency breach without hiding which asset', async () => {
    const p = pipeline();
    await p.store.putReserve({ assetId: 'usd', reserveRaw: 1n, supplyRaw: 2n, dustRaw: 0n });
    expect((await runPass(p)).breaches).toBe(1);
  });
});

describe('deposit scan cursor', () => {
  function chainOf(rows: Array<{ blockNumber: number; txHash: string; externalRaw?: string }>, head: () => number): ChainClient {
    return {
      finalizedBlock: async () => head(),
      deposits: async (from, to) => rows
        .filter((row) => row.blockNumber >= from && row.blockNumber <= (to ?? Number.MAX_SAFE_INTEGER))
        .map((row) => ({
          assetId: 'hkd',
          account: 'w1',
          externalRaw: row.externalRaw ?? '1000000',
          chain: 'ethereum',
          txHash: row.txHash,
          logIndex: 0,
          blockNumber: row.blockNumber,
        })),
      redemptions: async () => [],
      depositWindow: 3,
    };
  }

  function pipelineFor(store: MemoryStore, chain: ChainClient): Pipeline {
    return {
      store,
      assets: DEFAULT_ASSETS,
      chain,
      fromBlock: 0,
      live: false,
      minter: { mint: async () => ({ txHash: '0xmint' }) },
      treasury: { release: async () => ({ txHash: '0xrelease' }) },
      verifyDeposit: async () => true,
      close: async () => {},
    };
  }

  it('scans forward in windows and resumes from the persisted cursor', async () => {
    const store = new MemoryStore();
    let head = 10;
    const rows = [{ blockNumber: 5, txHash: '0xA1' }];
    const p = pipelineFor(store, chainOf(rows, () => head));

    const first = await runPass(p);
    expect(first.deposits).toEqual({ recorded: 1, skipped: 0, deferred: 0 });
    // Windows 0..2, 3..5, ... 9..10: the cursor is the next unprocessed block.
    expect(await store.getScanCursor('ethereum')).toBe(11);

    const second = await runPass(p);
    expect(second.deposits).toEqual({ recorded: 0, skipped: 0, deferred: 0 });
    expect(await store.getScanCursor('ethereum')).toBe(11);

    head = 20;
    rows.push({ blockNumber: 12, txHash: '0xA2' });
    const third = await runPass(p);
    expect(third.deposits?.recorded).toBe(1);
    expect(await store.getScanCursor('ethereum')).toBe(21);
    expect(await store.findOperationByKey('ethereum:0xa2:0')).toBeDefined();
  });

  it('never advances the cursor past an unprocessed window', async () => {
    const store = new MemoryStore();
    const chain: ChainClient = {
      finalizedBlock: async () => 10,
      deposits: async () => { throw new Error('rpc down'); },
      redemptions: async () => [],
      depositWindow: 3,
    };
    await expect(runPass(pipelineFor(store, chain))).rejects.toThrow('rpc down');
    expect(await store.getScanCursor('ethereum')).toBeUndefined();
  });
});
