#!/usr/bin/env node
/**
 * Distributor API mock for e2e — the counterpart of `eth-rpc-mock.mjs`.
 *
 * Implements exactly the contract in
 * `expo-app/sources/services/distributor.ts`, so the `ext-screen` flow can be
 * driven without a real distributor:
 *
 *   GET  /assets
 *   GET  /balances?account=
 *   GET  /statement?account=&limit=
 *   POST /transfers | /mint-requests | /redeem-requests
 *   GET  /transfers/:id
 *
 * Amounts are decimal strings of smallest units (6 dp here, matching the
 * wallet's single decimals constant).
 *
 * Behaviour worth knowing:
 * - an operation starts `pending`, moves to `processing` on the first poll and
 *   `completed` on the second, so the UI's polling path is exercised;
 * - `idempotencyKey` is honoured: a repeated POST returns the first operation;
 * - an unknown `assetId` is rejected with 404, like the real service.
 *
 * Usage:
 *   node e2e/distributor-mock.mjs [--port 8791] [--balance 1000000000]
 */

import http from 'node:http';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg('port', '8791'));
const START_BALANCE = BigInt(arg('balance', '1000000000')); // 1000.000000
const ASSETS = ['hkd', 'usd', 'gold', 'eth'];
// Funding rails travel with the listing, like the real service (`/assets`).
const ASSET_META = {
  hkd: { depositKind: 'bank', depositInstructions: 'Bank: 012-345-678 (segregated HKD reserve)', referencePrefix: 'HKD' },
  usd: { depositKind: 'bank', depositInstructions: 'Bank: 987-654-321 (segregated USD reserve)', referencePrefix: 'USD' },
  gold: { depositKind: 'vault', depositInstructions: 'Allocated-bar allocation at the vault', referencePrefix: 'GOLD' },
  eth: { depositKind: 'evm', depositAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' },
};

const balances = new Map(); // `${asset}:${account}` -> bigint
const operations = new Map(); // id -> { id, assetId, account, amount, status, polls }
const byKey = new Map(); // idempotencyKey -> id
const movements = []; // statement rows

let sequence = 0;
const nextId = (prefix) => `${prefix}_${++sequence}`;

const key = (assetId, account) => `${assetId}:${account}`;
const balanceOf = (assetId, account) => balances.get(key(assetId, account)) ?? START_BALANCE;
const setBalance = (assetId, account, value) => balances.set(key(assetId, account), value);

// The wallet page is served from another origin (Expo web on :18081), so the
// mock must allow cross-origin calls. The real service sits behind the
// same-origin Caddy proxy and does not need this.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function operationView(op) {
  op.polls += 1;
  if (op.polls === 1) op.status = 'processing';
  else if (op.polls >= 2) op.status = 'completed';
  const movement = movements.find((m) => m.id === op.id);
  if (movement) movement.status = op.status;
  return { id: op.id, status: op.status };
}

function createOperation(kind, body, debit) {
  if (body.idempotencyKey && byKey.has(body.idempotencyKey)) {
    const existing = operations.get(byKey.get(body.idempotencyKey));
    return { id: existing.id, status: existing.status };
  }
  if (!ASSETS.includes(String(body.assetId))) return null;
  if (!/^\d+$/.test(String(body.amount ?? '')) || BigInt(body.amount) <= 0n) return null;

  const amount = BigInt(body.amount);
  if (debit) {
    const available = balanceOf(body.assetId, body.account);
    if (available < amount) return { error: 409 };
    setBalance(body.assetId, body.account, available - amount);
  }

  const op = { id: nextId(kind), assetId: body.assetId, account: body.account, amount: amount.toString(), status: 'pending', polls: 0 };
  operations.set(op.id, op);
  if (body.idempotencyKey) byKey.set(body.idempotencyKey, op.id);
  movements.unshift({
    id: op.id,
    account: body.account,
    assetId: op.assetId,
    direction: kind === 'deposit' ? 'in' : 'out',
    amount: op.amount,
    status: 'pending',
    at: new Date().toISOString(),
    ...(body.memo ? { memo: String(body.memo) } : {}),
  });
  return { id: op.id, status: op.status };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/assets') {
    return json(res, 200, { items: ASSETS.map((assetId) => ({ assetId, ...ASSET_META[assetId] })) });
  }

  if (req.method === 'GET' && url.pathname === '/balances') {
    const account = url.searchParams.get('account') ?? '';
    if (!account) return json(res, 400, { error: 'account is required' });
    return json(res, 200, {
      items: ASSETS.map((assetId) => ({ assetId, available: balanceOf(assetId, account).toString() })),
    });
  }

  if (req.method === 'GET' && url.pathname === '/statement') {
    const account = url.searchParams.get('account') ?? '';
    if (!account) return json(res, 400, { error: 'account is required' });
    return json(res, 200, { items: movements.filter((m) => m.account === account).slice(0, 50) });
  }

  if (req.method === 'POST' && ['/transfers', '/mint-requests', '/redeem-requests'].includes(url.pathname)) {
    const body = await readBody(req);
    body.account = body.account ?? '';
    if (!body.account) return json(res, 400, { error: 'account is required' });
    const kind = url.pathname === '/transfers' ? 'transfer' : url.pathname.includes('mint') ? 'mint' : 'redeem';
    const debit = kind !== 'mint';
    const created = createOperation(kind, body, debit);
    if (!created) return json(res, 404, { error: `unknown asset: ${body.assetId}` });
    if (created.error) return json(res, created.error, { error: 'insufficient balance' });
    return json(res, 200, created);
  }

  const poll = url.pathname.match(/^\/transfers\/([^/]+)$/);
  if (req.method === 'GET' && poll) {
    const op = operations.get(decodeURIComponent(poll[1]));
    if (!op) return json(res, 404, { error: 'unknown operation' });
    return json(res, 200, operationView(op));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, breaches: [] });
  }

  return json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
});

/**
 * Start the mock on `port` (0 = ephemeral) and resolve its URL.
 * Used by the Playwright spec; the CLI below uses the same server.
 */
export function startDistributorMock(port = 0) {
  // Each test gets a clean distributor: state is module-level, so without this
  // a debit from one spec leaks into the next on the same worker.
  balances.clear();
  operations.clear();
  byKey.clear();
  movements.length = 0;
  sequence = 0;
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// CLI mode only: importing this module must not open a port.
// (`import.meta` is avoided on purpose: the Playwright runner loads this module
// through a CJS transform, where it is illegal.)
const invokedDirectly = (process.argv[1] || '').replace(/\\/g, '/').endsWith('/distributor-mock.mjs');
if (invokedDirectly) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[distributor-mock] http://127.0.0.1:${PORT} assets=${ASSETS.join(',')} balance=${START_BALANCE}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
