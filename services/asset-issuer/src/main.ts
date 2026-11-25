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
import { BigtAiRedemptionVerifier } from './l1.js';
import { createBigtAiWallet } from './l1.bigt-ai.js';
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

// A redemption is only accepted when the L1 return can be verified, so the
// HTTP process needs read access to the issuer's L1 wallet as well. It never
// signs here (minting/releasing runs in the executor).
const redemptionVerifier = process.env.L1_URL && process.env.L1_ISSUER_KEY
  ? new BigtAiRedemptionVerifier(
    createBigtAiWallet({
      url: process.env.L1_URL,
      network,
      issuerKeyHex: process.env.L1_ISSUER_KEY,
    }),
    assets,
  )
  : undefined;

const app = buildServer({
  store,
  assets,
  ...(process.env.CORS_ORIGIN ? { corsOrigin: process.env.CORS_ORIGIN } : {}),
  ...(process.env.DEPOSIT_XPUB ? { depositXpub: process.env.DEPOSIT_XPUB } : {}),
  ...(process.env.DEPOSIT_XPUB_PATH ? { depositXpubPath: process.env.DEPOSIT_XPUB_PATH } : {}),
  ...(process.env.DEPOSIT_ASSET_ID ? { defaultDepositAssetId: process.env.DEPOSIT_ASSET_ID } : {}),
  ...(process.env.MINT_API_TOKEN?.trim() ? { mintToken: process.env.MINT_API_TOKEN.trim() } : {}),
  ...(redemptionVerifier
    ? { verifyRedemption: (op, asset) => redemptionVerifier.check(op, asset) }
    : {}),
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
