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
 *   DEPOSIT_XPUB                  account-level xpub for per-user addresses
 *   DEPOSIT_XPUB_PATH             non-hardened path below it (default 0)
 *   DEPOSIT_ASSET_ID              default asset for /deposit-address
 *   AUTH_MODE / API_TOKEN / API_HMAC_SECRET   serve auth (off is Test-only)
 *   DEPOSIT_XPRV                  signing xprv for `sweep` (never for `serve`)
 *   DEPOSIT_XPRV_PATH             non-hardened path below the xprv (default 0)
 *   SWEEP_MIN_RAW                 minimum token balance worth sweeping
 *   SWEEP_NATIVE_RESERVE_WEI      ETH left behind after gas
 *   SWEEP_GAS_LIMIT               fallback gas limit (default 65000)
 *   SWEEP_ASSET_ID                limit a sweep to one asset
 *   ALLOW_LIVE_SWEEP=1            actually sign and broadcast (default: plan)
 *
 * Nothing here holds a custody key: releases go through `RefusingTreasury`
 * until the HSM/MPC adapter is wired, so a misconfigured redeem fails loudly
 * instead of half-executing.
 */

import { assertAuthAllowsNetwork, authFromEnv } from './auth.js';
import { EvmChainClient } from './chain.evm.js';
import { assetsFromEnv, type AssetConfig } from './config.js';
import { reconcile } from './domain.js';
import { runOnce, type DepositVerifier, type L1Minter, type Treasury } from './executor.js';
import { runSweep } from './sweep.evm.js';
import {
  CommandL1Minter,
  CommandSweepSigner,
  CommandTreasury,
  LocalSweepSigner,
  execCommandRunner,
  type SweepSigner,
} from './signers.js';
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

export type Command = 'once' | 'loop' | 'attest' | 'health' | 'serve' | 'sweep';

export interface SweepConfig {
  live: boolean;
  minTokenRaw: bigint;
  nativeReserveWei: bigint;
  gasLimit: bigint;
  /** HSM/MPC signer command; preferred over the local xprv. */
  signCommand?: string;
  /** Local testnet/small-float signer. */
  xprv?: string;
  xprvPath: string;
  assetId?: string;
}

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
  /** L1 mint signer: local key, an external HSM/MPC command, or refusing. */
  l1Signer: 'local' | 'command' | 'refusing';
  l1MintCommand?: string;
  treasuryCommand?: string;
  treasuryLive: boolean;
  signerTimeoutMs: number;
  sweep: SweepConfig;
}

const COMMANDS: Command[] = ['once', 'loop', 'attest', 'health', 'serve', 'sweep'];

function bigintEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): bigint {
  const raw = (env[name] ?? fallback).trim();
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error('negative');
    return value;
  } catch {
    throw new Error(`${name} must be a non-negative integer in smallest units, got '${raw}'`);
  }
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const command = (argv[0] ?? 'once') as Command;
  if (!COMMANDS.includes(command)) {
    throw new Error(`unknown command '${command}' (use ${COMMANDS.join(', ')})`);
  }
  const header = env.DATABASE_URL ?? env.POSTGRES_URL;
  const rawNetwork = env.NETWORK ?? 'Test';
  if (rawNetwork !== 'Test' && rawNetwork !== 'Mainnet') {
    throw new Error(`NETWORK must be Test or Mainnet, got '${rawNetwork}'`);
  }
  const network: CliOptions['network'] = rawNetwork;
  if (!header && network !== 'Test') {
    throw new Error('DATABASE_URL (or POSTGRES_URL) is required outside Test');
  }

  const l1MintCommand = env.L1_MINT_COMMAND?.trim() || undefined;
  const rawSigner = env.L1_SIGNER?.trim()
    || (l1MintCommand ? 'command' : env.L1_ISSUER_KEY ? 'local' : 'refusing');
  if (rawSigner !== 'local' && rawSigner !== 'command' && rawSigner !== 'refusing') {
    throw new Error(`L1_SIGNER must be local, command or refusing, got '${rawSigner}'`);
  }
  if (rawSigner === 'command' && !l1MintCommand) {
    throw new Error('L1_SIGNER=command requires L1_MINT_COMMAND');
  }
  const signerTimeoutMs = Number(env.SIGNER_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(signerTimeoutMs) || signerTimeoutMs <= 0) {
    throw new Error('SIGNER_TIMEOUT_MS must be a positive number');
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
    l1Signer: rawSigner,
    ...(l1MintCommand ? { l1MintCommand } : {}),
    ...(env.TREASURY_RELEASE_COMMAND?.trim()
      ? { treasuryCommand: env.TREASURY_RELEASE_COMMAND.trim() }
      : {}),
    treasuryLive: env.ALLOW_LIVE_TREASURY === '1',
    signerTimeoutMs,
    sweep: {
      live: env.ALLOW_LIVE_SWEEP === '1',
      minTokenRaw: bigintEnv(env, 'SWEEP_MIN_RAW', '0'),
      nativeReserveWei: bigintEnv(env, 'SWEEP_NATIVE_RESERVE_WEI', '0'),
      gasLimit: bigintEnv(env, 'SWEEP_GAS_LIMIT', '65000'),
      ...(env.SWEEP_SIGN_COMMAND?.trim() ? { signCommand: env.SWEEP_SIGN_COMMAND.trim() } : {}),
      ...(env.DEPOSIT_XPRV ? { xprv: env.DEPOSIT_XPRV } : {}),
      xprvPath: env.DEPOSIT_XPRV_PATH ?? env.DEPOSIT_XPUB_PATH ?? '0',
      ...(env.SWEEP_ASSET_ID || env.DEPOSIT_ASSET_ID
        ? { assetId: (env.SWEEP_ASSET_ID ?? env.DEPOSIT_ASSET_ID) as string }
        : {}),
    },
  };
}

export interface Pipeline {
  store: Store;
  assets: AssetConfig[];
  chain?: ChainClient;
  minter: L1Minter;
  treasury: Treasury;
  fromBlock: number;
  live: boolean;
  /** Set when an EVM deposit source exists; the executor fails closed without it. */
  verifyDeposit?: DepositVerifier;
  close: () => Promise<void>;
}

function missing(reason: string) {
  return { mint: async (): Promise<never> => { throw new Error(`minting unavailable: ${reason}`); } };
}

export function buildPipeline(options: CliOptions, wallet?: WalletLike): Pipeline {
  const store: Store = options.databaseUrl ? new PgStore(options.databaseUrl) : new MemoryStore();
  // In `command` mode no L1 key exists in this process: the HSM/MPC service
  // owns reissue+pay, so there is also no local redemption scanner.
  const walletLike = options.l1Signer === 'local'
    ? wallet
      ?? (options.l1Url && options.issuerKey
        ? createBigtangleWallet({
          url: options.l1Url,
          network: options.network,
          issuerKeyHex: options.issuerKey,
        })
        : undefined)
    : undefined;

  const deposits = options.ethRpcUrl
    ? new EvmChainClient({
      rpcUrl: options.ethRpcUrl,
      assets: options.assets,
      // Per-user addresses are the attribution key; an empty list keeps the
      // shared `custodyAddress` path (and its `mapAccount` fallback).
      depositAddresses: async (asset) => (await store.listDepositAddresses(asset.assetId))
        .map((entry) => ({ address: entry.address, account: entry.account })),
      // In per-user mode the sender is not an identity (often an exchange hot
      // wallet): a transfer to the omnibus is skipped, not credited to it.
      mapAccount: (from, asset) => (asset.depositAddressMode === 'per-user' ? undefined : from),
    })
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
    minter: options.l1Signer === 'command' && options.l1MintCommand
      ? new CommandL1Minter(options.l1MintCommand, execCommandRunner(options.signerTimeoutMs))
      : walletLike
        ? new BigtangleL1Minter({ wallet: walletLike, assets: options.assets, live: options.live })
        : missing('set L1_URL + L1_ISSUER_KEY or L1_MINT_COMMAND'),
    treasury: options.treasuryLive && options.treasuryCommand
      ? new CommandTreasury(options.treasuryCommand, execCommandRunner(options.signerTimeoutMs))
      : new RefusingTreasury(),
    ...(deposits ? { verifyDeposit: (op, asset) => deposits.verifyDeposit(op, asset) } : {}),
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
    l1: pipeline.minter,
    treasury: pipeline.treasury,
    now: () => new Date().toISOString(),
    ...(pipeline.verifyDeposit ? { verifyDeposit: pipeline.verifyDeposit } : {}),
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
    if (options.command === 'sweep') {
      if (!options.ethRpcUrl) throw new Error('ETH_RPC_URL is required for sweep');
      let signer: SweepSigner | undefined;
      if (options.sweep.live) {
        if (options.sweep.signCommand) {
          signer = new CommandSweepSigner(
            options.sweep.signCommand,
            execCommandRunner(options.signerTimeoutMs),
          );
        } else if (options.sweep.xprv) {
          signer = new LocalSweepSigner(options.sweep.xprv, options.sweep.xprvPath);
        }
      }
      const result = await runSweep({
        store: pipeline.store,
        assets: pipeline.assets,
        rpcUrl: options.ethRpcUrl,
        minTokenRaw: options.sweep.minTokenRaw,
        nativeReserveWei: options.sweep.nativeReserveWei,
        gasLimit: options.sweep.gasLimit,
        live: options.sweep.live,
        ...(signer ? { signer } : {}),
        ...(options.sweep.assetId ? { assetId: options.sweep.assetId } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (options.command === 'serve') {
      const auth = authFromEnv(process.env);
      assertAuthAllowsNetwork(auth, options.network);
      buildServer({
        store: pipeline.store,
        assets: pipeline.assets,
        ...(process.env.DEPOSIT_XPUB ? { depositXpub: process.env.DEPOSIT_XPUB } : {}),
        ...(process.env.DEPOSIT_XPUB_PATH ? { depositXpubPath: process.env.DEPOSIT_XPUB_PATH } : {}),
        ...(process.env.DEPOSIT_ASSET_ID ? { defaultDepositAssetId: process.env.DEPOSIT_ASSET_ID } : {}),
        network: options.network,
        auth,
      }).listen({
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
