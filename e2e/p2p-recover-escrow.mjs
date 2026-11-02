#!/usr/bin/env node
/**
 * Sweep a P2P demo escrow vault back to its seller with a 2-of-3 spend.
 *
 * The vault is (seller, buyer, engine); the demo script holds the seller and
 * buyer keys, so it can move the funds out WITHOUT the engine — exactly the
 * refund path (`seller + engine`) minus the engine, using `seller + buyer`.
 *
 * Usage: node p2p-recover-escrow.mjs <rail> [--to <base58>]
 *        (keys: demo-output/p2p-prod-keys.json, written by capture-p2p-prod.mjs)
 */
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  Address, Coin, Escrow, FreeStandingTransactionOutput, MainNetParams, PQKey, UTXO, Wallet, escrowSpendAmount,
} from 'bigtangle-ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const L0 = (process.env.L0_URL || 'https://eu1.bigtangle.org').replace(/\/+$/, '') + '/';
const ENGINE = (process.env.ENGINE_URL || 'https://wallet.bigt.ai/p2p').replace(/\/+$/, '');
const KEYS_FILE = process.env.KEYS_FILE || resolve(HERE, 'demo-output', 'p2p-prod-keys.json');
const rail = process.argv[2];
if (!rail) { console.error('usage: p2p-recover-escrow.mjs <rail> [--to <base58>]'); process.exit(2); }
const toIdx = process.argv.indexOf('--to');
const toAddr = toIdx > 0 ? process.argv[toIdx + 1] : '';

const all = JSON.parse(readFileSync(KEYS_FILE, 'utf-8'));
const row = all[rail];
if (!row) { console.error(`no keys for rail ${rail} in ${KEYS_FILE}`); process.exit(2); }
const sellerKey = PQKey.fromPrivateKeyHex(row.seller);
const buyerKey = PQKey.fromPrivateKeyHex(row.buyer);
const params = MainNetParams.get();

const caps = await (await fetch(`${ENGINE}/capabilities`)).json();
const engineKey = PQKey.fromPrefixedPublicKey(Buffer.from(caps.escrowPubkey, 'hex'));
const vault = Escrow.twoOfThree({ seller: sellerKey, buyer: buyerKey, engine: engineKey });
const vaultAddr = vault.address(params).toBase58();
const to = toAddr || Address.fromKey(params, sellerKey).toString();
console.log(`vault ${vaultAddr}`);
console.log(`to    ${to}`);

const res = await fetch(`${L0}getOutputsHistory`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fromaddress: '', toaddress: vaultAddr, starttime: null, endtime: null }),
});
const { outputs = [] } = await res.json();
const raw = outputs.find((o) => o.spent !== true && o.confirmed !== false && (o.tokenId ?? o.tokenid) === 'bc');
if (!raw) { console.log('nothing to recover (no unspent BIG output)'); process.exit(0); }
console.log(`escrow ${raw.value.value} units (${Number(raw.value.value) / 1e6} BIG) tx ${raw.hashHex}`);

const utxo = UTXO.fromJSONObject(raw);
const blockHash = utxo.getBlockHash();
const value = utxo.getValue();
const out = escrowSpendAmount(value);
const tx = vault.createSpend({
  params,
  blockHash,
  utxo: new FreeStandingTransactionOutput(params, utxo),
  to: Address.fromBase58(params, to),
  amount: out,
  memo: 'demo-escrow-recovery',
});
const signed = vault.signInput(tx, 0, [sellerKey, buyerKey]);
console.log(`signed with ${signed} keys, paying ${out.getValue()} units`);

const w = Wallet.fromKeysURL(params, [sellerKey], L0);
w.setServerURL(L0);
await w.submitTransaction(tx);
const txHash = tx.getHash().toString();
console.log(`submitted ${txHash}`);
for (let i = 0; i < 60; i++) {
  const st = await (await fetch(`${L0}getTransactionStatus`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash }),
  })).json().catch(() => ({}));
  if (st.status === 'CONFIRMED') { console.log(`CONFIRMED ${txHash}`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`sent ${txHash} (not confirmed yet)`);
