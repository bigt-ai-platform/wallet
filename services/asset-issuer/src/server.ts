/**
 * Issuer HTTP service.
 *
 * Implements exactly the contract the wallet already speaks
 * (`expo-app/sources/services/distributor.ts`), so adding the service does not
 * change the client:
 *
 *   GET  /health
 *   GET  /assets
 *   GET  /balances?account=
 *   GET  /statement?account=&limit=
 *   POST /transfers
 *   POST /mint-requests
 *   POST /redeem-requests
 *   GET  /transfers/:id
 *
 * What this service deliberately does *not* do: hold keys. Minting/releasing is
 * an executor job with an HSM/MPC signer; the HTTP layer only validates, records
 * an operation and enforces the invariants. That keeps the request path free of
 * key material and makes every state change replayable.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { DEFAULT_ASSETS, findAssetConfig, type AssetConfig } from './config.js';
import {
  canMint,
  chainKey,
  reconcile,
  transition,
  withinCaps,
  type Operation,
  type OperationKind,
  type OperationStatus,
} from './domain.js';
import type { Store } from './store.js';
import { emptyStatusCounts, renderMetrics } from './metrics.js';

export interface ServerOptions {
  store: Store;
  assets?: AssetConfig[];
  /**
   * Browser origin allowed to call this service directly. In production the
   * wallet reaches it same-origin behind the proxy, so this stays unset; the
   * wire test (web app on another port) sets it.
   */
  corsOrigin?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Injectable id generator for deterministic tests. */
  newId?: () => string;
}

interface OperationBody {
  account?: string;
  assetId?: string;
  amount?: string;
  to?: string;
  memo?: string;
  reference?: string;
  idempotencyKey?: string;
}

const DIRECTIONS: Record<OperationKind, 'in' | 'out'> = {
  deposit: 'in',
  mint: 'in',
  withdrawal: 'out',
  redeem: 'out',
  transfer: 'out',
};

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store } = options;
  const assets = options.assets ?? DEFAULT_ASSETS;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => `op_${Math.random().toString(36).slice(2, 12)}`);
  const app = Fastify({ logger: false });

  if (options.corsOrigin) {
    app.addHook('onSend', async (_request, reply) => {
      reply.header('access-control-allow-origin', options.corsOrigin as string);
      reply.header('access-control-allow-headers', 'content-type,authorization');
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    });
    app.options('/*', async (_request, reply) => reply.code(204).send());
  }

  const enabled = () => assets.filter((a) => a.enabled);

  function requireAsset(assetId: string | undefined): AssetConfig {
    if (!assetId) throw new HttpError(400, 'assetId is required');
    const asset = findAssetConfig(enabled(), assetId);
    if (!asset) throw new HttpError(404, `unknown or disabled asset: ${assetId}`);
    return asset;
  }

  function requireAmount(raw: string | undefined): bigint {
    if (!raw || !/^\d+$/.test(raw)) throw new HttpError(400, 'amount must be a decimal string of smallest units');
    const value = BigInt(raw);
    if (value <= 0n) throw new HttpError(400, 'amount must be > 0');
    return value;
  }

  function requireAccount(account: string | undefined): string {
    const value = (account ?? '').trim();
    if (!value) throw new HttpError(400, 'account is required');
    return value;
  }

  async function idempotent(key: string | undefined): Promise<Operation | undefined> {
    if (!key) return undefined;
    return store.findOperationByClientKey(key);
  }

  async function createOperation(
    kind: OperationKind,
    fields: Pick<Operation, 'assetId' | 'account' | 'amountRaw' | 'l1AmountRaw'>,
    idempotencyKey?: string,
  ): Promise<Operation> {
    const timestamp = now();
    const op: Operation = {
      id: newId(),
      kind,
      ...fields,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.saveOperation(op);
    return op;
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.message });
    }
    return reply.status(500).send({ error: 'internal error' });
  });

  app.get('/health', async () => {
    const breaches = reconcile(await store.listReserves());
    return { ok: breaches.length === 0, breaches };
  });

  app.get('/metrics', async (_request, reply) => {
    const reserves = await store.listReserves();
    const counts = emptyStatusCounts();
    for (const status of Object.keys(counts) as OperationStatus[]) {
      counts[status] = (await store.listOperationsByStatus(status, 1000)).length;
    }
    reply.type('text/plain; version=0.0.4');
    return renderMetrics(reserves, counts);
  });

  app.get('/assets', async () => ({
    items: enabled().map((a) => ({
      assetId: a.assetId,
      symbol: a.symbol,
      decimals: a.l1Decimals,
      depositKind: a.depositKind,
      ...(a.depositInstructions ? { depositInstructions: a.depositInstructions } : {}),
      ...(a.depositAddress ? { depositAddress: a.depositAddress } : {}),
      ...(a.referencePrefix ? { referencePrefix: a.referencePrefix } : {}),
    })),
  }));

  app.get('/balances', async (request) => {
    const account = requireAccount((request.query as { account?: string }).account);
    const items = [];
    for (const asset of enabled()) {
      const balance = await store.getHolderBalance(asset.assetId, account);
      items.push({
        assetId: asset.assetId,
        available: (balance?.availableRaw ?? 0n).toString(),
        pending: (balance?.pendingRaw ?? 0n).toString(),
      });
    }
    return { items };
  });

  app.get('/statement', async (request) => {
    const query = request.query as { account?: string; limit?: string };
    const account = requireAccount(query.account);
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
    const operations = await store.listOperations(account, limit);
    return {
      items: operations.map((op) => ({
        id: op.id,
        assetId: op.assetId,
        direction: DIRECTIONS[op.kind],
        amount: op.l1AmountRaw,
        status: op.status,
        at: op.createdAt,
        ...(op.externalRef ? { hash: op.externalRef } : {}),
      })),
    };
  });

  app.post('/transfers', async (request) => {
    const body = (request.body ?? {}) as OperationBody;
    const account = requireAccount(body.account);
    const asset = requireAsset(body.assetId);
    const amount = requireAmount(body.amount);
    const to = (body.to ?? '').trim();
    if (!to) throw new HttpError(400, 'recipient is required');
    if (body.idempotencyKey) {
      const existing = await idempotent(body.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
    }
    const balance = await store.getHolderBalance(asset.assetId, account);
    if (!balance || balance.availableRaw < amount) {
      throw new HttpError(409, 'insufficient balance');
    }
    await store.putHolderBalance({
      ...balance,
      availableRaw: balance.availableRaw - amount,
      pendingRaw: balance.pendingRaw + amount,
    });
    const op = await createOperation('transfer', {
      assetId: asset.assetId,
      account,
      amountRaw: amount.toString(),
      l1AmountRaw: amount.toString(),
    }, body.idempotencyKey);
    return { id: op.id, status: op.status };
  });

  app.post('/mint-requests', async (request) => {
    const body = (request.body ?? {}) as OperationBody;
    const account = requireAccount(body.account);
    const asset = requireAsset(body.assetId);
    const amount = requireAmount(body.amount);
    if (body.idempotencyKey) {
      const existing = await idempotent(body.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
    }
    const reserve = await store.getReserve(asset.assetId);
    if (!reserve) throw new HttpError(409, 'no reserve credited for this asset; deposit first');
    const caps = { maxSupplyRaw: asset.maxSupplyRaw, maxMintRaw: asset.maxMintRaw };
    if (!canMint(reserve, amount) || !withinCaps(reserve, amount, caps)) {
      throw new HttpError(409, 'mint exceeds the reserve or the asset cap');
    }
    // The reserve is debited only when the mint executor confirms the block;
    // recording the intent first keeps the request replayable.
    const op = await createOperation('mint', {
      assetId: asset.assetId,
      account,
      amountRaw: amount.toString(),
      l1AmountRaw: amount.toString(),
    }, body.idempotencyKey);
    return { id: op.id, status: op.status };
  });

  app.post('/redeem-requests', async (request) => {
    const body = (request.body ?? {}) as OperationBody;
    const account = requireAccount(body.account);
    const asset = requireAsset(body.assetId);
    const amount = requireAmount(body.amount);
    if (body.idempotencyKey) {
      const existing = await idempotent(body.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
    }
    const balance = await store.getHolderBalance(asset.assetId, account);
    if (!balance || balance.availableRaw < amount) {
      throw new HttpError(409, 'insufficient balance');
    }
    await store.putHolderBalance({
      ...balance,
      availableRaw: balance.availableRaw - amount,
      pendingRaw: balance.pendingRaw + amount,
    });
    const op = await createOperation('redeem', {
      assetId: asset.assetId,
      account,
      amountRaw: amount.toString(),
      l1AmountRaw: amount.toString(),
    }, body.idempotencyKey);
    return { id: op.id, status: op.status };
  });

  app.get('/transfers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const op = await store.getOperation(id);
    if (!op) throw new HttpError(404, `unknown operation: ${id}`);
    return { id: op.id, status: op.status };
  });

  return app;
}

/** Exported for the executor, which advances operations once chain events land. */
export async function advance(
  store: Store,
  operationId: string,
  to: OperationStatus,
  now: () => string = () => new Date().toISOString(),
  error?: string,
): Promise<Operation> {
  const op = await store.getOperation(operationId);
  if (!op) throw new Error(`unknown operation: ${operationId}`);
  const next = transition(op, to, now(), error);
  await store.saveOperation(next);
  return next;
}

/** Idempotency guard used by the deposit watcher before it creates anything. */
export async function alreadyObserved(store: Store, chain: string, txHash: string, logIndex: number): Promise<boolean> {
  return !!(await store.findOperationByKey(chainKey({ chain, txHash, logIndex })));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
