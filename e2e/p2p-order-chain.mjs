#!/usr/bin/env node
/**
 * p2p-order-chain.mjs — chain fixtures for the `p2p-orders` e2e part.
 *
 * The seller anchors its own `social.p2p-order` record on L1-SOCIAL (the exact
 * path expo-app/sources/services/p2p.ts createOrder/cancelOrder takes), waits
 * for the tx to CONFIRM, and hands the spec both the txid and the semantic
 * fields the engine's POST /orders expects. `sign` then wraps any field set in
 * the engine's authenticated envelope (did + nonce + timestamp + PQ signature
 * over the canonical body), mirroring the app's `signedBody`.
 *
 * Usage (stdout is one JSON object; `--out <file>` also writes it):
 *   node p2p-order-chain.mjs keygen
 *   node p2p-order-chain.mjs fund --keys <hexSeed,hexSeed> [--units <bigint>]
 *   node p2p-order-chain.mjs anchor-order --key <hexSeed> --orderId ord-…
 *       [--status OPEN|CANCELLED] [--terms <json>]
 *   node p2p-order-chain.mjs sign --key <hexSeed> --fields <json>
 *
 * env: E2E_L1_SOCIAL_URL (default http://127.0.0.1:24091/)
 * Requires the workspace dist packages (build_p2p_engine builds them).
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PQKey, TestParams, Wallet, Address, Utils, NetworkParameters } from '../packages/bigtangle-ts/dist/index.js';
import { didFromPQKey, signChallengePQ } from '../packages/did/dist/pq.js';
import { recordDigest } from '../packages/record-sig/dist/index.js';
import { p2pOrderRecord } from '../packages/p2p-protocol/dist/index.js';
import { submitSocialRecord } from '../services/p2p-engine/dist/anchor.js';
import { canonicalJson } from '../services/p2p-engine/dist/sign.js';
import { HttpChainClient } from '../services/p2p-engine/dist/chain.js';

const SOCIAL_URL = (process.env.E2E_L1_SOCIAL_URL || 'http://127.0.0.1:24091/').replace(/\/+$/, '');
const FUNDER_SEED = new Uint8Array(32).fill(0x04); // Test genesis row (e2e/l1social.sh SOCIAL_VALIDATOR_KEY)
const DEFAULT_UNITS = 5000000n; // 5 BIG (1 BIG = 10^6 units) — plenty for fee-bearing spends

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} requires a value`);
  return v;
}

function out(result) {
  const json = JSON.stringify(result);
  const file = arg('out');
  if (file) writeFileSync(file, json);
  process.stdout.write(json + '\n');
}

function requireArg(name) {
  const v = arg(name);
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

/** Poll getTransactionStatus until CONFIRMED (the same gate the engine applies). */
async function waitConfirmed(txid, tries = 90) {
  const client = new HttpChainClient(SOCIAL_URL);
  for (let i = 0; i < tries; i++) {
    try {
      const st = await client.transactionStatus(txid);
      if (st.status === 'CONFIRMED') return;
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${txid} not CONFIRMED on ${SOCIAL_URL} after ${tries * 2}s`);
}

/** Wait until the key holds a spendable BIG candidate (helpers.waitForConfirmedBc pattern). */
async function waitSpendable(pqKey, tries = 60) {
  const wallet = Wallet.fromKeysURL(TestParams.get(), [pqKey], SOCIAL_URL + '/');
  for (let i = 0; i < tries; i++) {
    const cands = await wallet.calculateAllSpendCandidates(null, false).catch(() => []);
    if (cands.some((c) => {
      const u = c.getUTXO();
      return u && u.getValue() && u.getValue().getValue() > 0n;
    })) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no spendable BIG candidate for ${didFromPQKey(pqKey)}`);
}

async function keygen() {
  const key = PQKey.createNew();
  const seed = key.getPrivateKeySeedAsHex();
  if (!seed) throw new Error('PQKey did not expose a private seed');
  return {
    key: seed,
    did: didFromPQKey(key),
    address: Address.fromKey(TestParams.get(), key).toString(),
  };
}

async function fund() {
  const seeds = requireArg('keys').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seeds.length) throw new Error('--keys needs at least one seed');
  const units = BigInt(arg('units', DEFAULT_UNITS.toString()));
  const funder = PQKey.fromMLDSA(FUNDER_SEED);
  const wallet = Wallet.fromKeysURL(TestParams.get(), [funder], SOCIAL_URL + '/');
  const giveMoney = new Map();
  const addresses = [];
  for (const seed of seeds) {
    const key = PQKey.fromPrivateKeyHex(seed);
    const addr = Address.fromKey(TestParams.get(), key).toString();
    addresses.push(addr);
    giveMoney.set(addr, units);
  }
  const coinList = await wallet.calculateAllSpendCandidates(null, false);
  if (!coinList.length) throw new Error(`social genesis wallet has no spend candidates on ${SOCIAL_URL}`);
  const tx = await wallet.payMoneyToECKeyList(
    null,
    giveMoney,
    new Uint8Array(Utils.HEX.decode(NetworkParameters.BIGTANGLE_TOKENID_STRING)),
    'p2p-orders-e2e',
    coinList,
  );
  if (!tx) throw new Error('social genesis funding produced no transaction');
  const txid = tx.getHash().toString();
  await waitConfirmed(txid);
  for (const seed of seeds) await waitSpendable(PQKey.fromPrivateKeyHex(seed));
  return { txid, addresses };
}

async function anchorOrder() {
  const seed = requireArg('key');
  const orderId = requireArg('orderId');
  const status = arg('status', 'OPEN');
  const terms = JSON.parse(arg('terms', '{}'));
  const pqKey = PQKey.fromPrivateKeyHex(seed);
  const did = didFromPQKey(pqKey);
  const record = p2pOrderRecord({
    from: did,
    to: orderId,
    ...terms,
    status,
    ...(status === 'CANCELLED' ? { orderSeq: 1 } : {}),
    ts: Date.now(),
  });
  const signed = { ...record, sigScheme: 'mldsa', sig: signChallengePQ(pqKey, recordDigest(record)) };
  const txid = await submitSocialRecord(SOCIAL_URL, pqKey, signed);
  await waitConfirmed(txid);
  // The semantic fields POST /orders expects — record terms and intake body
  // are produced from one source so A (intake) and B (replay) cannot drift.
  const fields = status === 'CANCELLED'
    ? { sellerDid: did, orderId, txid }
    : { sellerDid: did, orderId, txid, ...terms };
  return { txid, did, fields };
}

async function sign() {
  const pqKey = PQKey.fromPrivateKeyHex(requireArg('key'));
  const fields = JSON.parse(requireArg('fields'));
  const did = didFromPQKey(pqKey);
  const payload = { ...fields, did, nonce: randomBytes(16).toString('hex'), timestamp: Date.now() };
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  const signature = signChallengePQ(pqKey, digest);
  return { did, body: { ...payload, signature } };
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'keygen': return out(await keygen());
    case 'fund': return out(await fund());
    case 'anchor-order': return out(await anchorOrder());
    case 'sign': return out(await sign());
    default:
      throw new Error(`unknown command '${cmd || ''}' (keygen|fund|anchor-order|sign)`);
  }
}

main().catch((e) => {
  console.error(`p2p-order-chain: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
