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
  formatAmount,
  reconcile,
  transition,
  withinCaps,
  type ChainRef,
  type Operation,
  type OperationKind,
  type OperationStatus,
} from './domain.js';
import type { Store } from './store.js';
import { emptyStatusCounts, renderMetrics } from './metrics.js';
import { toChecksumAddress } from './depositAddress.js';
import { ensureDepositAddress } from './depositService.js';
import { AuthError, checkBearer, checkHmac, safeEqual, type AuthConfig } from './auth.js';
import {
  REDEEM_INTENT_DOMAIN,
  intentHash,
  validateIntentFields,
  verifyRedeemIntent,
  type IntentKeyType,
  type RedeemIntent,
  type RedeemNetwork,
} from './intent.js';
import { bytesToHex } from './ethTx.js';
import type { RedemptionMatch } from './l1.js';

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
  /**
   * Fallback xpub for per-user deposit addresses. An asset's `depositXpub`
   * wins; this is the service-wide `DEPOSIT_XPUB`.
   */
  depositXpub?: string;
  /** Fallback non-hardened path below the xpub (default `0`). */
  depositXpubPath?: string;
  /** Asset served by `/deposit-address` when the query omits `assetId`. */
  defaultDepositAssetId?: string;
  /** Network bound into signed intents (default Test). */
  network?: RedeemNetwork;
  /**
   * Request authentication. Default `off` for tests; `main`/`serve` refuse
   * `off` outside Test (see `assertAuthAllowsNetwork`).
   */
  auth?: AuthConfig;
  /**
   * Operator credential for `POST /mint-requests`. Mint authority is separate
   * from the wallet-facing bearer: the app's `EXPO_PUBLIC_ISSUER_API_TOKEN` is
   * shipped in the bundle, so it must never be able to mint against the pooled
   * reserve. Absent = the mint API is disabled.
   */
  mintToken?: string;
  /**
   * Confirms a redemption is backed by a finalized L1 transfer to the asset's
   * `redemptionAddress`. Without it `/redeem-intents` fails closed.
   */
  verifyRedemption?: (operation: Operation, asset: AssetConfig) => Promise<RedemptionMatch>;
}

interface OperationBody {
  account?: string;
  assetId?: string;
  amount?: string;
  to?: string;
  memo?: string;
  reference?: string;
  idempotencyKey?: string;
  /** Signed redemption intent. */
  destination?: string;
  /** L1 funding transaction hash for the redemption. */
  l1TxHash?: string;
  nonce?: string;
  expiry?: number;
  keyType?: IntentKeyType;
  publicKey?: string;
  signature?: string;
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
  const auth = options.auth ?? { mode: 'off' as const };

  function header(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  // Default-deny: only `/health` is public. `/metrics` is included so the
  // balance/operation counters are not an unauthenticated leak.
  app.addHook('preValidation', async (request) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (request.method === 'OPTIONS' || path === '/health') return;
    if (auth.mode === 'off') return;

    if (auth.mode === 'bearer') {
      checkBearer(auth, header(request.headers.authorization));
      return;
    }

    const query = (request.query ?? {}) as { account?: string };
    const body = (request.body ?? {}) as { account?: string };
    const account = (query.account ?? body.account ?? '').trim();
    const timestamp = header(request.headers['x-timestamp']) ?? '';
    checkHmac(
      auth,
      { method: request.method, path, account, timestamp, body: request.body },
      {
        account: header(request.headers['x-account']),
        timestamp,
        signature: header(request.headers['x-signature']),
      },
    );
  });

  if (options.corsOrigin) {
    app.addHook('onSend', async (_request, reply) => {
      reply.header('access-control-allow-origin', options.corsOrigin as string);
      reply.header('access-control-allow-headers', 'content-type,authorization');
      reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
    });
    app.options('/*', async (_request, reply) => reply.code(204).send());
  }

  const enabled = () => assets.filter((a) => a.enabled);

  /** Asset for the deposit page: explicit id, else the configured default, else the first EVM asset. */
  function requireDepositAsset(assetId: string | undefined): AssetConfig {
    const pool = enabled();
    const id = (assetId ?? options.defaultDepositAssetId ?? '').trim();
    if (id) {
      const asset = findAssetConfig(pool, id);
      if (!asset) throw new HttpError(404, `unknown or disabled asset: ${id}`);
      return asset;
    }
    const asset = pool.find((a) => a.depositKind === 'evm') ?? pool[0];
    if (!asset) throw new HttpError(404, 'no asset is configured for deposits');
    return asset;
  }

  /** EIP-55 when the value is an EVM address; otherwise pass it through. */
  function displayAddress(value: string): string {
    try {
      return toChecksumAddress(value);
    } catch {
      return value;
    }
  }

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
    fields: Pick<Operation, 'assetId' | 'account' | 'amountRaw' | 'l1AmountRaw'> & {
      destination?: string;
      externalRef?: string;
      ref?: ChainRef;
    },
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

  /**
   * Operator-only mint authority. The wallet-facing bearer is shipped in the
   * web bundle, so it is not a mint credential: a caller that holds it must not
   * be able to issue supply against the pooled reserve.
   */
  function requireMintAuthority(headers: Record<string, string | string[] | undefined>): void {
    if (!options.mintToken) {
      throw new HttpError(403, 'the mint API is disabled: set MINT_API_TOKEN on the issuer');
    }
    const presented = header(headers['x-mint-token']) ?? '';
    if (!safeEqual(presented, options.mintToken)) {
      throw new HttpError(403, 'invalid mint credential');
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthError) {
      return reply.status(error.status).send({ error: error.message });
    }
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: error.message,
        ...(error.retryable ? { retryable: true } : {}),
      });
    }
    return reply.status(500).send({ error: 'internal error' });
  });

  app.get('/health', async () => {
    const breaches = reconcile(await store.listReserves());
    // Historical redeem rows cannot have their output index recovered from the
    // hash; surface unsettled index-0 rows so an operator audits them.
    const legacyRedeemRefs = await store.countRedeemRefsAtZero();
    return { ok: breaches.length === 0, breaches, legacyRedeemRefs };
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
      ...(a.depositAddressMode ? { depositAddressMode: a.depositAddressMode } : {}),
      ...(a.referencePrefix ? { referencePrefix: a.referencePrefix } : {}),
      // The wallet must send L1 tokens here before it can sign a redemption;
      // exposing it is what makes the funding leg possible.
      ...(a.redemptionAddress ? { redemptionAddress: a.redemptionAddress } : {}),
      // The canonical L1 token id: the wallet must pay this exact token, not a
      // same-named token it happens to hold.
      ...(a.l1TokenId ? { l1TokenId: a.l1TokenId } : {}),
    })),
  }));

  /**
   * Deposit address for the `/deposit` page (`services/ethBridge.ts`).
   *
   * `per-user` derives a BIP32 address for the L1 account, so the address — not
   * the sender — attributes an exchange-origin ERC-20 deposit. `static` returns
   * the shared custody address.
   */
  app.get('/deposit-address', async (request) => {
    const query = request.query as { account?: string; assetId?: string };
    const account = requireAccount(query.account);
    const asset = requireDepositAsset(query.assetId);
    const memo = asset.depositMemo ? { memo: asset.depositMemo } : {};

    if ((asset.depositAddressMode ?? 'static') === 'per-user') {
      const xpub = asset.depositXpub ?? options.depositXpub;
      if (!xpub) {
        throw new HttpError(503, 'per-user deposit addresses are not configured: set DEPOSIT_XPUB');
      }
      try {
        const record = await ensureDepositAddress({
          store,
          asset,
          xpub,
          path: asset.depositXpubPath ?? options.depositXpubPath ?? '0',
          chain: asset.depositKind === 'evm' ? 'ethereum' : asset.assetId,
          now,
        }, account);
        return { address: displayAddress(record.address), ...memo };
      } catch (error) {
        throw new HttpError(
          503,
          `deposit address derivation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const address = asset.depositAddress ?? asset.custodyAddress;
    if (!address) throw new HttpError(404, `no deposit address configured for ${asset.assetId}`);
    return { address: displayAddress(address), ...memo };
  });

  /**
   * Deposit history for the `/deposit` page: display units, and the page's
   * `pending | credited | failed` vocabulary. Amounts use the L1 scale, which
   * is the amount the user will see credited.
   */
  app.get('/deposits', async (request) => {
    const query = request.query as { account?: string; assetId?: string; limit?: string };
    const account = requireAccount(query.account);
    const assetFilter = (query.assetId ?? '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
    const operations = await store.listDeposits(account, assetFilter || undefined, limit);

    const items = operations
      .map((op) => {
        const asset = findAssetConfig(assets, op.assetId);
        const status = op.status === 'completed'
          ? 'credited'
          : op.status === 'failed'
            ? 'failed'
            : 'pending';
        return {
          hash: op.ref?.txHash ?? op.externalRef ?? op.id,
          amount: formatAmount(op.l1AmountRaw, asset?.l1Decimals ?? 6),
          status,
          ...(op.status === 'completed' ? { creditedAt: op.updatedAt } : {}),
        };
      });

    return { items };
  });

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
        ...(op.externalRef || op.payoutRef ? { hash: op.externalRef ?? op.payoutRef } : {}),
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
      // The executor needs the recipient; dropping it turned every transfer
      // into a payment to the empty address.
      externalRef: to,
    }, body.idempotencyKey);
    return { id: op.id, status: op.status };
  });

  app.post('/mint-requests', async (request) => {
    requireMintAuthority(request.headers);
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

  /**
   * Signed redemption: the destination is bound to the L1 account by an L1-key
   * signature, and the nonce/hash is stored so it cannot be replayed. This is
   * the only path that authorizes a treasury release.
   *
   * The signature proves *who* chose the destination; it does not prove the
   * tokens were returned. The intent therefore names the L1 funding transaction,
   * and the release is refused unless that transaction pays the exact token and
   * amount to the issuer's redemption address at finality. Its
   * `(chain, txHash, logIndex)` is unique, so one L1 return backs one release.
   */
  app.post('/redeem-intents', async (request) => {
    const body = (request.body ?? {}) as OperationBody;
    const account = requireAccount(body.account);
    const asset = requireAsset(body.assetId);
    const amount = requireAmount(body.amount);
    if (body.idempotencyKey) {
      const existing = await idempotent(body.idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status };
    }
    if (!body.keyType || !body.publicKey || !body.signature) {
      throw new HttpError(400, 'keyType, publicKey and signature are required');
    }

    const intent: RedeemIntent = {
      domain: REDEEM_INTENT_DOMAIN,
      network: options.network ?? 'Test',
      assetId: asset.assetId,
      account,
      amountRaw: amount.toString(),
      destination: (body.destination ?? '').trim(),
      l1TxHash: (body.l1TxHash ?? '').trim(),
      nonce: (body.nonce ?? '').trim(),
      expiry: Number(body.expiry),
    };

    const fields = validateIntentFields(intent, Date.now());
    if (!fields.ok) throw new HttpError(400, fields.error);

    const proof = {
      keyType: body.keyType,
      publicKey: body.publicKey,
      signature: body.signature,
    };
    const verified = verifyRedeemIntent(intent, proof);
    if (!verified.ok) throw new HttpError(401, verified.error);

    if (!options.verifyRedemption) {
      throw new HttpError(
        503,
        'redemption is not configured: the issuer needs L1_URL + L1_ISSUER_KEY to verify the L1 return',
      );
    }

    const timestamp = now();
    const op: Operation = {
      id: newId(),
      kind: 'redeem',
      assetId: asset.assetId,
      account,
      amountRaw: amount.toString(),
      l1AmountRaw: amount.toString(),
      destination: intent.destination,
      ref: { chain: 'l1-order', txHash: intent.l1TxHash, logIndex: 0 },
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      status: 'pending',
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const check = await options.verifyRedemption(op, asset);
    if (check.status === 'pending') {
      throw new HttpError(
        409,
        'the L1 funding transfer is not confirmed yet; retry shortly',
        true,
      );
    }
    if (check.status !== 'ok' || check.txHash === undefined || check.logIndex === undefined) {
      throw new HttpError(
        409,
        `no confirmed L1 transfer of ${amount.toString()} to the ${asset.assetId} redemption address`,
      );
    }

    // Store the outpoint the verifier actually matched (canonical hash + real
    // output index), never the client's spelling or a hardcoded index 0. The
    // unique index then enforces "one matched return, one release".
    op.ref = { chain: 'l1-order', txHash: check.txHash, logIndex: check.logIndex };

    // Nonce, intent hash, L1 funding ref, pending operation and the (optional)
    // holder-balance debit are one atomic write, so a worker cannot claim a
    // release before its debit is committed.
    const stored = await store.putRedeemRequest({
      assetId: asset.assetId,
      account,
      nonce: intent.nonce,
      intentHash: bytesToHex(intentHash(intent).getBytes()),
      destination: intent.destination,
      amountRaw: amount.toString(),
      expiry: intent.expiry,
      operationId: op.id,
      createdAt: timestamp,
    }, op, amount);
    if (!stored.ok) {
      throw new HttpError(409, 'redeem intent nonce, hash or L1 funding was already used');
    }
    return { id: op.id, status: op.status };
  });

  // Kept for compatibility, but a destination cannot be authorized without a
  // signature. Redirect callers to the signed-intent path instead of debiting
  // a balance that could never be released.
  app.post('/redeem-requests', async () => {
    throw new HttpError(400, 'redeem requires a signed intent: POST /redeem-intents');
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
  constructor(readonly status: number, message: string, readonly retryable = false) {
    super(message);
    this.name = 'HttpError';
  }
}
