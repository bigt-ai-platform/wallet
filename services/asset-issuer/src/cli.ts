/**
 * Issuer runner.
 *
 *   node dist/cli.js once      one scan -> execute -> attest pass (cron/CI)
 *   node dist/cli.js loop      the same, every INTERVAL_MS (default 60 s)
 *   node dist/cli.js attest    publish reserve attestations only
 *   node dist/cli.js health    print the solvency check and exit non-zero on breach
 *
 * Env:
 *   DATABASE_URL | POSTGRES_URL   required outside Test (never the memory store)
 *   ETH_RPC_URL                   enables ERC-20 deposit scanning
 *   L1_URL + L1_ISSUER_KEY        enables minting and redemption scanning
 *   ALLOW_LIVE_L1=1               required to actually sign a mint
 *   FROM_BLOCK                    deposit scan cursor (default 0)
 *   INTERVAL_MS                   loop interval (default 60000)
 *
 * Nothing here holds a custody key: releases go through `RefusingTreasury`
 * until the HSM/MPC adapter is wired, so a misconfigured redeem fails loudly
 * instead of half-executing.
 */

import { EvmChainClient } from './chain.evm.js';
import { assetsFromEnv, type AssetConfig } from './config.js';
import { reconcile } from './domain.js';
import { runOnce } from './executor.js';
import { publishAttestations } from './attestation.js';
import {
  BigtangleL1Minter,
  BigtangleRedemptionSource,
  RefusingTreasury,
  composeChainClient,
  type WalletLike,
} from './l1.js';
import { createBigtangleWallet } from './l1.bigtangle.js';
import { buildServer } from './server.js';
import { MemoryStore, type Store } from './store.js';
import { PgStore } from './store.pg.js';
import { scanDeposits, scanRedemptions, type ChainClient } from './watcher.js';

export type Command = 'once' | 'loop' | 'attest' | 'health' | 'serve';

export interface CliOptions {
  command: Command;
  assets: AssetConfig[];
  fromBlock: number;
  intervalMs: number;
  databaseUrl?: string;
  ethRpcUrl?: string;
  l1Url?: string;
  issuerKey?: string;
  live: boolean;
  network: 'Test' | 'Mainnet';
}

const COMMANDS: Command[] = ['once', 'loop', 'attest', 'health', 'serve'];

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const command = (argv[0] ?? 'once') as Command;
  if (!COMMANDS.includes(command)) {
    throw new Error(`unknown command '${command}' (use ${COMMANDS.join(', ')})`);
  }
  const header = env.DATABASE_URL ?? env.POSTGRES_URL;
  const network: CliOptions['network'] = env.NETWORK === 'Mainnet' ? 'Mainnet' : 'Test';
  if (!header && network !== 'Test') {
    throw new Error('DATABASE_URL (or POSTGRES_URL) is required outside Test');
  }
  return {
    command,
    assets: assetsFromEnv(env.ASSETS_JSON),
    fromBlock: Number(env.FROM_BLOCK ?? 0) || 0,
    intervalMs: Number(env.INTERVAL_MS ?? 60000) || 60000,
    ...(header ? { databaseUrl: header } : {}),
    ...(env.ETH_RPC_URL ? { ethRpcUrl: env.ETH_RPC_URL } : {}),
    ...(env.L1_URL ? { l1Url: env.L1_URL } : {}),
    ...(env.L1_ISSUER_KEY ? { issuerKey: env.L1_ISSUER_KEY } : {}),
    live: env.ALLOW_LIVE_L1 === '1',
    network,
  };
}

export interface Pipeline {
  store: Store;
  assets: AssetConfig[];
  chain?: ChainClient;
  minter: BigtangleL1Minter | { mint: () => Promise<never> };
  fromBlock: number;
  live: boolean;
  close: () => Promise<void>;
}

function missing(reason: string) {
  return { mint: async (): Promise<never> => { throw new Error(`minting unavailable: ${reason}`); } };
}

export function buildPipeline(options: CliOptions, wallet?: WalletLike): Pipeline {
  const store: Store = options.databaseUrl ? new PgStore(options.databaseUrl) : new MemoryStore();
  const walletLike = wallet
    ?? (options.l1Url && options.issuerKey
      ? createBigtangleWallet({
        url: options.l1Url,
        network: options.network,
        issuerKeyHex: options.issuerKey,
      })
      : undefined);

  const deposits = options.ethRpcUrl
    ? new EvmChainClient({ rpcUrl: options.ethRpcUrl, assets: options.assets })
    : undefined;
  const redemptions = walletLike
    ? new BigtangleRedemptionSource(walletLike, options.assets)
    : undefined;

  return {
    store,
    assets: options.assets,
    ...(deposits && redemptions
      ? { chain: composeChainClient(deposits, redemptions) }
      : deposits
        ? { chain: composeChainClient(deposits, { redemptions: async () => [] }) }
        : {}),
    minter: walletLike
      ? new BigtangleL1Minter({ wallet: walletLike, assets: options.assets, live: options.live })
      : missing('set L1_URL + L1_ISSUER_KEY'),
    fromBlock: options.fromBlock,
    live: options.live,
    close: async () => {
      if (store instanceof PgStore) await store.close();
    },
  };
}

export interface PassSummary {
  deposits: { recorded: number; skipped: number; deferred: number } | null;
  redemptions: { recorded: number; skipped: number; deferred: number } | null;
  executed: { completed: number; failed: number; skipped: number } | null;
  attestations: number;
  breaches: number;
}

export async function runPass(pipeline: Pipeline): Promise<PassSummary> {
  const summary: PassSummary = { deposits: null, redemptions: null, executed: null, attestations: 0, breaches: 0 };
  if (pipeline.chain) {
    summary.deposits = await scanDeposits({
      store: pipeline.store,
      client: pipeline.chain,
      assets: pipeline.assets,
      now: () => new Date().toISOString(),
      newId: () => `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    }, pipeline.fromBlock);
    summary.redemptions = await scanRedemptions({
      store: pipeline.store,
      client: pipeline.chain,
      assets: pipeline.assets,
      now: () => new Date().toISOString(),
      newId: () => `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    }, pipeline.fromBlock);
  }
  summary.executed = await runOnce({
    store: pipeline.store,
    assets: pipeline.assets,
    l1: pipeline.minter as never,
    treasury: new RefusingTreasury(),
    now: () => new Date().toISOString(),
  });
  summary.attestations = (await publishAttestations({
    store: pipeline.store,
    publisher: { publish: async () => { /* publication target lands with the chain adapter */ } },
    now: () => new Date().toISOString(),
  })).length;
  summary.breaches = reconcile(await pipeline.store.listReserves()).length;
  return summary;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  const pipeline = buildPipeline(options);
  try {
    if (options.command === 'health') {
      const breaches = reconcile(await pipeline.store.listReserves());
      console.log(JSON.stringify({ ok: breaches.length === 0, breaches }, null, 2));
      process.exitCode = breaches.length === 0 ? 0 : 1;
      return;
    }
    if (options.command === 'serve') {
      buildServer({ store: pipeline.store, assets: pipeline.assets }).listen({
        port: Number(process.env.PORT ?? 8090), host: '0.0.0.0',
      });
      return;
    }
    if (options.command === 'attest') {
      const published = await publishAttestations({
        store: pipeline.store,
        publisher: { publish: async () => {} },
        now: () => new Date().toISOString(),
      });
      console.log(JSON.stringify({ attestations: published.length }));
      return;
    }
    if (options.command === 'loop') {
      console.log(`[asset-issuer] loop every ${options.intervalMs} ms (live=${options.live})`);
      const tick = async () => {
        try {
          console.log(JSON.stringify(await runPass(pipeline)));
        } catch (error) {
          console.error('[asset-issuer] pass failed', error instanceof Error ? error.message : error);
        }
      };
      await tick();
      setInterval(() => { void tick(); }, options.intervalMs);
      return;
    }
    console.log(JSON.stringify(await runPass(pipeline), null, 2));
  } finally {
    if (options.command !== 'loop' && options.command !== 'serve') await pipeline.close();
  }
}

// CLI mode only; importing this module must not run a pass.
// (`import.meta` is avoided on purpose: some tooling loads this through CJS.)
const invokedDirectly = (process.argv[1] || '').replace(/\\/g, '/').endsWith('/cli.js')
  || (process.argv[1] || '').replace(/\\/g, '/').endsWith('/cli.ts');
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[asset-issuer]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
