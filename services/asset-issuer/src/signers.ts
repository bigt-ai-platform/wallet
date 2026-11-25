/**
 * HSM/MPC adapter seam.
 *
 * A signer is an external process (the vendor's CLI/agent) that holds the key.
 * The service speaks a small JSON protocol over stdin/stdout and never sees
 * key material. `execCommandRunner` uses `spawn` with no shell, a timeout and
 * bounded output.
 *
 * Three operations:
 *   - `sweep-sign`       deposit address → signed type-2 transaction
 *   - `l1-mint`          reissue + pay on L1-order
 *   - `treasury-release` release the external asset on redemption
 *
 * Every adapter is fail-closed: a missing command or a malformed response is an
 * error, never a fallback to a local key.
 */

import { spawn } from 'node:child_process';
import * as secp256k1 from 'secp256k1';
import type { L1Minter, Treasury } from './executor.js';
import { addressFromPublicKey, privateKeyAt } from './depositAddress.js';
import {
  bytesToHex,
  hexToBytes,
  signType2,
  type Type2Tx,
} from './ethTx.js';

/** One JSON request/response per invocation. */
export type CommandRunner = (command: string, payload: unknown) => Promise<unknown>;

const MAX_STDOUT = 1_000_000;
const MAX_STDERR = 8_000;

export function execCommandRunner(timeoutMs = 30_000): CommandRunner {
  return (command, payload) => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };

    let child;
    try {
      child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`signer command timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_STDOUT) {
        child.kill('SIGKILL');
        finish(new Error('signer command output exceeded the limit'));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });
    child.stdin?.on('error', () => { /* the exit/error handler reports it */ });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`signer command exited ${code}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      finish(null);
    });

    child.stdin?.end(JSON.stringify(payload));
  });
}

function parseJsonOutput(output: unknown): Record<string, unknown> {
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (!trimmed) throw new Error('signer command returned no output');
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('signer command returned invalid JSON');
    }
  }
  if (output && typeof output === 'object') return output as Record<string, unknown>;
  throw new Error('signer command returned an unsupported response');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`signer response is missing ${name}`);
  return value.trim();
}

// ─── Sweep signing ──────────────────────────────────────────────────────────

export interface SweepSignRequest {
  /** Allocated address the transaction must spend from. */
  address: string;
  addressIndex: number;
  chainId: string;
  nonce: string;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  gasLimit: string;
  /** Token contract. */
  to: string;
  /** ERC-20 calldata. */
  data: string;
}

export interface SweepSignResult {
  /** Complete signed type-2 transaction (`0x02…`). */
  rawTransaction: string;
  /** Address that signed it; the sweeper compares it to the allocation. */
  signer: string;
}

export interface SweepSigner {
  sign(request: SweepSignRequest): Promise<SweepSignResult>;
}

/** Testnet / small-float signer. Production should use {@link CommandSweepSigner}. */
export class LocalSweepSigner implements SweepSigner {
  constructor(
    private readonly xprv: string,
    private readonly path: string,
  ) {}

  async sign(request: SweepSignRequest): Promise<SweepSignResult> {
    const key = privateKeyAt(this.xprv, this.path, request.addressIndex);
    const signer = addressFromPublicKey(secp256k1.publicKeyCreate(key, false));
    if (signer.toLowerCase() !== request.address.toLowerCase()) {
      throw new Error(`xprv derives ${signer}, not requested address ${request.address}`);
    }
    const tx: Type2Tx = {
      chainId: BigInt(request.chainId),
      nonce: BigInt(request.nonce),
      maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(request.maxFeePerGas),
      gasLimit: BigInt(request.gasLimit),
      to: hexToBytes(request.to),
      value: 0n,
      data: hexToBytes(request.data),
    };
    const signed = signType2(tx, key);
    return { rawTransaction: bytesToHex(signed.raw), signer };
  }
}

export class CommandSweepSigner implements SweepSigner {
  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = execCommandRunner(),
  ) {}

  async sign(request: SweepSignRequest): Promise<SweepSignResult> {
    const response = parseJsonOutput(await this.runner(this.command, {
      op: 'sweep-sign',
      ...request,
    }));
    const rawTransaction = requireString(response.rawTransaction, 'rawTransaction');
    const signer = requireString(response.signer, 'signer');
    const raw = hexToBytes(rawTransaction);
    if (raw.length === 0 || raw[0] !== 0x02) {
      throw new Error('signer response is not a type-2 transaction');
    }
    return { rawTransaction, signer };
  }
}

export class RefusingSweepSigner implements SweepSigner {
  async sign(): Promise<never> {
    throw new Error('sweep signing is not configured: set SWEEP_SIGN_COMMAND or DEPOSIT_XPRV');
  }
}

// ─── L1 minting ─────────────────────────────────────────────────────────────

/**
 * Delegates the whole reissue+pay step to an HSM-backed service. The command
 * receives the asset id, account and amount; it owns the token mapping and the
 * M-of-N signing policy, so the issuer process holds no L1 key.
 */
export class CommandL1Minter implements L1Minter {
  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = execCommandRunner(),
  ) {}

  async mint(
    assetId: string,
    account: string,
    l1Raw: string,
    context?: { operationId: string },
  ): Promise<{ txHash: string }> {
    const response = parseJsonOutput(await this.runner(this.command, {
      op: 'l1-mint',
      assetId,
      account,
      amountRaw: l1Raw,
      // The signer must return the same tx for the same operation, so a retry
      // after a crash cannot reissue a second time.
      ...(context ? { operationId: context.operationId } : {}),
    }));
    return { txHash: requireString(response.txHash, 'txHash') };
  }
}

// ─── Treasury release ───────────────────────────────────────────────────────

/**
 * Delegates the external release to an HSM/MPC process. The command is
 * responsible for the destination policy (the L1 account must already resolve
 * to the holder's verified Ethereum address); the service only asks for a
 * release by asset/account/amount.
 */
export class CommandTreasury implements Treasury {
  constructor(
    private readonly command: string,
    private readonly runner: CommandRunner = execCommandRunner(),
  ) {}

  async release(
    assetId: string,
    account: string,
    destination: string,
    externalRaw: string,
    context?: { operationId: string },
  ): Promise<{ txHash: string }> {
    const response = parseJsonOutput(await this.runner(this.command, {
      op: 'treasury-release',
      assetId,
      account,
      destination,
      externalRaw,
      // A retried release must return the original tx, never pay twice.
      ...(context ? { operationId: context.operationId } : {}),
    }));
    return { txHash: requireString(response.txHash, 'txHash') };
  }
}
