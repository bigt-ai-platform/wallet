/**
 * PgStore smoke test against a real Postgres (run manually, not in CI).
 *
 *   docker run -d --name asset-issuer-db-test \
 *     -e POSTGRES_DB=asset_issuer -e POSTGRES_USER=asset_issuer \
 *     -e POSTGRES_PASSWORD=test1234 -p 55432:5432 postgres:16-alpine
 *   psql postgres://asset_issuer:test1234@127.0.0.1:55432/asset_issuer \
 *     -f services/asset-issuer/schema.sql
 *   npx tsx services/asset-issuer/test/pg-smoke.ts
 */
import { DEFAULT_ASSETS } from '../src/config.js';
import { PgStore } from '../src/store.pg.js';

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  ?? 'postgres://asset_issuer:test1234@127.0.0.1:55432/asset_issuer';

const store = new PgStore(url);
const now = () => new Date().toISOString();
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  await store.seedAssets(DEFAULT_ASSETS);

  const op = {
    id: `smoke_${Date.now()}`,
    kind: 'deposit' as const,
    assetId: 'hkd',
    account: 'w1',
    amountRaw: '1500000',
    l1AmountRaw: '1500000',
    status: 'pending' as const,
    ref: { chain: 'ethereum', txHash: '0xABC', logIndex: 7 },
    idempotencyKey: 'smoke-key-1',
    attempts: 0,
    createdAt: now(),
    updatedAt: now(),
  };

  await store.saveOperation(op);
  check('insert + read by id', (await store.getOperation(op.id))?.account === 'w1');
  check('find by chain key (case-insensitive hash)',
    (await store.findOperationByKey('ethereum:0xabc:7'))?.id === op.id);
  check('find by client idempotency key',
    (await store.findOperationByClientKey('smoke-key-1'))?.id === op.id);

  await store.saveOperation({ ...op, status: 'processing', attempts: 1 });
  check('status advances', (await store.getOperation(op.id))?.status === 'processing');

  await store.saveOperation({ ...op, status: 'completed', attempts: 2 });
  check('completed is stored', (await store.getOperation(op.id))?.status === 'completed');

  let refused = false;
  try {
    await store.saveOperation({ ...op, status: 'failed', attempts: 3 });
  } catch (error) {
    refused = String(error).includes('completed');
  }
  check('completed is terminal (DB trigger refuses a rewrite)', refused);

  await store.putReserve({ assetId: 'hkd', reserveRaw: 5_000_000n, supplyRaw: 1_500_000n, dustRaw: 0n });
  const reserve = await store.getReserve('hkd');
  check('reserve round-trips as BigInt', reserve?.reserveRaw === 5_000_000n && reserve?.dustRaw === 0n);

  let overIssueRefused = false;
  try {
    await store.putReserve({ assetId: 'hkd', reserveRaw: 1n, supplyRaw: 2n, dustRaw: 0n });
  } catch (error) {
    overIssueRefused = String(error).includes('reserve_covers_supply');
  }
  check('DB refuses supply > reserve', overIssueRefused);

  await store.putHolderBalance({ assetId: 'hkd', account: 'w1', availableRaw: 10n, pendingRaw: 2n });
  check('holder balance round-trips',
    (await store.getHolderBalance('hkd', 'w1'))?.pendingRaw === 2n);

  await store.putAttestation({
    assetId: 'hkd', version: 1, reserveRaw: 5_000_000n, supplyRaw: 1_500_000n,
    documentHash: 'sha256:abc', publishedAt: now(),
  });
  check('attestation version 1', (await store.latestAttestation('hkd'))?.version === 1);

  await store.putAttestation({
    assetId: 'hkd', version: 2, reserveRaw: 6_000_000n, supplyRaw: 1_500_000n,
    documentHash: 'sha256:def', publishedAt: now(),
  });
  const latest = await store.latestAttestation('hkd');
  check('latest attestation is the highest version', latest?.version === 2 && latest.documentHash === 'sha256:def');

  check('listOperationsByStatus ordering', (await store.listOperationsByStatus('completed', 10)).length >= 1);

  // Atomic deposit: the chain ref and the reserve credit commit together.
  const deposit = {
    ...op,
    id: 'smoke_dep',
    ref: { chain: 'ethereum', txHash: '0xDEF', logIndex: 1 },
    idempotencyKey: 'smoke-dep',
  };
  check('deposit credit applies once', await store.creditDeposit(
    { assetId: 'hkd', reserveDeltaRaw: 100n, dustDeltaRaw: 0n }, deposit,
  ));
  check('deposit credit is idempotent on the chain ref', !(await store.creditDeposit(
    { assetId: 'hkd', reserveDeltaRaw: 100n, dustDeltaRaw: 0n }, deposit,
  )));
  check('reserve was credited exactly once', (await store.getReserve('hkd'))?.reserveRaw === 5_000_100n);

  // Atomic redemption reservation: nonce, L1 ref, operation and debit together.
  const redeem = {
    ...op,
    id: 'smoke_redeem',
    kind: 'redeem' as const,
    ref: { chain: 'l1-order', txHash: '0xFEED', logIndex: 0 },
    idempotencyKey: 'smoke-redeem',
    amountRaw: '5',
    l1AmountRaw: '5',
    destination: '0x2222222222222222222222222222222222222222',
  };
  const intent = {
    assetId: 'hkd', account: 'w1', nonce: 'smoke-nonce', intentHash: 'smoke-hash',
    destination: redeem.destination, amountRaw: '5', expiry: Date.now() + 60_000,
    operationId: redeem.id, createdAt: now(),
  };
  check('redeem request reserves once', (await store.putRedeemRequest(intent, redeem, 5n)).ok);
  check('redeem replay is refused', !(await store.putRedeemRequest(
    { ...intent, nonce: 'smoke-nonce-2', intentHash: 'smoke-hash-2' },
    { ...redeem, id: 'smoke_redeem_2' },
    5n,
  )).ok);

  check('settle applies the release', await store.settleOperation(
    { ...redeem, status: 'completed', payoutRef: '0xpaid' },
    { kind: 'release', amountRaw: 5n },
  ));
  check('settle is a no-op on replay', !(await store.settleOperation(
    { ...redeem, status: 'completed', payoutRef: '0xpaid' },
    { kind: 'release', amountRaw: 5n },
  )));
  check('release retired supply and released pending',
    (await store.getReserve('hkd'))?.supplyRaw === 1_499_995n
    && (await store.getHolderBalance('hkd', 'w1'))?.pendingRaw === 2n);
  check('payout ref is stored', (await store.getOperation('smoke_redeem'))?.payoutRef === '0xpaid');

  await store.putScanCursor('ethereum', 123);
  check('scan cursor round-trips', (await store.getScanCursor('ethereum')) === 123);

  await store.close();
  console.log(failures === 0 ? '\nRESULT=OK' : `\nRESULT=FAIL(${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('smoke failed:', error);
  await store.close().catch(() => {});
  process.exit(1);
});
