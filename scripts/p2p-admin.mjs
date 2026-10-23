#!/usr/bin/env node
/**
 * scripts/p2p-admin.mjs — arbiter CLI for the P2P engine (docs/p2p.md §27).
 * Signs a dispute outcome with an arbiter DID key listed in the engine's
 * SETTLEMENT_ADMIN_DIDS; the shared admin token cannot move funds then.
 *
 *   node scripts/p2p-admin.mjs --new-key ~/.p2p-arbiter.key   # encrypted key (0600), prints its DID
 *   P2P_ADMIN_KEY_FILE=~/.p2p-arbiter.key \
 *     node scripts/p2p-admin.mjs resolve https://wallet.bigt.ai/p2p swap-0123456789abcdef refund
 *
 * The key file is scrypt + AES-256-GCM encrypted; the passphrase is prompted
 * (hidden) or taken from P2P_ADMIN_PASSPHRASE for automation.
 * The signed path is the engine-side route (no proxy prefix), as the engine checks it.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Ed25519Key, didFromEd25519Key, hexToBytes, bytesToHex } from 'did';

const [cmd, ...rest] = process.argv.slice(2);
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;

function canonicalJson(payload) {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

async function passphrase(prompt) {
  if (process.env.P2P_ADMIN_PASSPHRASE) return process.env.P2P_ADMIN_PASSPHRASE;
  if (!process.stdin.isTTY) die('no TTY: set P2P_ADMIN_PASSPHRASE');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write(prompt);
  // Hide the typed passphrase.
  rl._writeToOutput = () => {};
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return answer;
}

function encryptKey(privHex, pass) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(privHex, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex'),
  });
}

function decryptKey(file, pass) {
  const box = JSON.parse(file);
  if (box.v !== 1 || box.kdf !== 'scrypt') die('unsupported key file format');
  const key = scryptSync(pass, Buffer.from(box.salt, 'hex'), 32, { N: box.N, r: box.r, p: box.p, maxmem: SCRYPT.maxmem });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return die('wrong passphrase (or the key file was modified)', 1);
  }
}

if (cmd === '--new-key') {
  const out = rest[0];
  if (!out) die('usage: p2p-admin.mjs --new-key <file>');
  const pass = await passphrase('new passphrase: ');
  if (pass.length < MIN_PASSPHRASE) die(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  if (!process.env.P2P_ADMIN_PASSPHRASE && (await passphrase('repeat passphrase: ')) !== pass) die('passphrases differ');
  const key = Ed25519Key.createNewKey();
  writeFileSync(out, `${encryptKey(key.getPrivHex(), pass)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`wrote ${out} (0600, encrypted)`);
  console.log(`arbiter DID (add to SETTLEMENT_ADMIN_DIDS): ${didFromEd25519Key(key)}`);
  process.exit(0);
}

if (cmd !== 'resolve' || rest.length !== 3 || !['release', 'refund'].includes(rest[2])) {
  die('usage: p2p-admin.mjs resolve <engineUrl> <swapId> <release|refund>');
}
const [engineUrl, swapId, outcome] = rest;
const keyFile = process.env.P2P_ADMIN_KEY_FILE;
if (!keyFile) die('set P2P_ADMIN_KEY_FILE to the arbiter key file');
const raw = readFileSync(keyFile, 'utf8').trim();
if (!raw.startsWith('{')) die('key file is not encrypted — regenerate it with --new-key');
const key = Ed25519Key.fromPrivateBytes(hexToBytes(decryptKey(raw, await passphrase('passphrase: '))));
const did = didFromEd25519Key(key);
const requestPath = `/swaps/${swapId}/dispute/resolve`;
const payload = {
  did,
  outcome,
  nonce: randomBytes(16).toString('hex'),
  timestamp: Date.now(),
  requestMethod: 'POST',
  requestPath,
};
const signature = bytesToHex(key.sign(new TextEncoder().encode(canonicalJson(payload))));
try {
  const res = await fetch(`${engineUrl.replace(/\/+$/, '')}${requestPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, signature }),
  });
  console.log(res.status, await res.text());
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  die(`request failed: ${e.cause?.message ?? e.message}`, 1);
}
