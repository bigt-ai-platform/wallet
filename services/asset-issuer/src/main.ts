/**
 * Entry point.
 *
 * Binds the tested domain + HTTP layer to storage: Postgres when
 * `DATABASE_URL`/`POSTGRES_URL` is set, in-memory otherwise. The in-memory store
 * loses every operation on restart, including the idempotency keys, so the
 * service refuses to start outside `NETWORK=Test` without a database.
 */

import { assertAuthAllowsNetwork, authFromEnv } from './auth.js';
import { assetsFromEnv } from './config.js';
import { buildServer } from './server.js';
import { MemoryStore, type Store } from './store.js';
import { PgStore } from './store.pg.js';

const port = Number(process.env.PORT ?? 8090);
// Accept both names: `DATABASE_URL` is the generic one, `POSTGRES_URL` matches
// the p2p-engine stack so one `.env` convention covers both services.
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
const rawNetwork = process.env.NETWORK ?? 'Test';
if (rawNetwork !== 'Test' && rawNetwork !== 'Mainnet') {
  // A typo must not silently select Test and skip the DB/auth gates.
  console.error(`[asset-issuer] NETWORK must be Test or Mainnet, got '${rawNetwork}'`);
  process.exit(1);
}
const network: 'Test' | 'Mainnet' = rawNetwork;

// Fail closed: no unauthenticated HTTP outside Test.
const auth = authFromEnv(process.env);
assertAuthAllowsNetwork(auth, network);

if (!databaseUrl && network !== 'Test') {
  console.error('[asset-issuer] refusing to start: DATABASE_URL (or POSTGRES_URL) is required outside Test');
  process.exit(1);
}

let store: Store;
const assets = assetsFromEnv(process.env.ASSETS_JSON);
if (databaseUrl) {
  const pg = new PgStore(databaseUrl);
  await pg.seedAssets(assets);
  store = pg;
} else {
  store = new MemoryStore();
  console.warn('[asset-issuer] WARNING: in-memory store — operations and idempotency keys are lost on restart');
}

const app = buildServer({
  store,
  assets,
  ...(process.env.CORS_ORIGIN ? { corsOrigin: process.env.CORS_ORIGIN } : {}),
  ...(process.env.DEPOSIT_XPUB ? { depositXpub: process.env.DEPOSIT_XPUB } : {}),
  ...(process.env.DEPOSIT_XPUB_PATH ? { depositXpubPath: process.env.DEPOSIT_XPUB_PATH } : {}),
  ...(process.env.DEPOSIT_ASSET_ID ? { defaultDepositAssetId: process.env.DEPOSIT_ASSET_ID } : {}),
  network,
  auth,
});

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[asset-issuer] listening on :${port} (network=${network}, assets=${assets.length}, store=${databaseUrl ? 'postgres' : 'memory'})`))
  .catch((error) => {
    console.error('[asset-issuer] failed to start', error);
    process.exit(1);
  });
