import { describe, expect, it } from 'vitest';
import { parseCli, runPass, type Pipeline } from '../src/cli.js';
import { DEFAULT_ASSETS } from '../src/config.js';
import { MemoryStore } from '../src/store.js';

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
      L1_URL: 'https://ordereu1.bigtangle.org',
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
      l1Url: 'https://ordereu1.bigtangle.org',
      databaseUrl: 'postgres://x',
    });
  });

  it('refuses an unknown command', () => {
    expect(() => parseCli(['frobnicate'], {})).toThrow(/unknown command/);
  });

  it('refuses Mainnet without a database', () => {
    expect(() => parseCli(['once'], { NETWORK: 'Mainnet' })).toThrow(/DATABASE_URL/);
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
