#!/usr/bin/env node
/**
 * One-off migration: encrypt plaintext `SETTLEMENT_STORE=blob` objects in place.
 *
 * The engine used to run with SETTLEMENT_BLOB_KEY unset, so FsBlobStore wrote
 * `{key, value}` records with the value in clear. EncryptedBlobStore expects
 * `value` to be an AES-256-GCM envelope; this script wraps every plaintext
 * value with that envelope (same format as blob.ts) and is idempotent — objects
 * that already carry an envelope are left untouched.
 *
 * Usage (inside a container with the blob volume mounted at /data/blobs):
 *   docker run --rm -v <volume>:/data/blobs -v $PWD/migrate.mjs:/migrate.mjs:ro \
 *     -e SETTLEMENT_BLOB_KEY=<32-byte hex> --entrypoint node <engine-image> /migrate.mjs
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.env.SETTLEMENT_BLOB_DIR?.trim() || '/data/blobs';
const keyHex = (process.env.SETTLEMENT_BLOB_KEY || '').trim();
if (!keyHex) {
  console.error('migrate: SETTLEMENT_BLOB_KEY is required');
  process.exit(1);
}
const raw = Buffer.from(keyHex, 'hex');
// Keep the exact derivation EncryptedBlobStore uses.
const key = raw.length === 32 ? raw : createHash('sha256').update(keyHex, 'utf8').digest();

const isEnvelope = (v) =>
  !!v &&
  typeof v === 'object' &&
  v.alg === 'aes-256-gcm' &&
  typeof v.iv === 'string' &&
  typeof v.ct === 'string' &&
  typeof v.tag === 'string';

async function main() {
  let encrypted = 0;
  let skipped = 0;
  let failed = 0;

  const collections = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const coll of collections) {
    const cdir = join(dir, coll);
    const files = (await readdir(cdir)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const path = join(cdir, f);
      let rec;
      try {
        rec = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        failed += 1;
        console.warn('migrate: unreadable', path);
        continue;
      }
      if (!rec || typeof rec.key !== 'string' || !Object.prototype.hasOwnProperty.call(rec, 'value')) {
        failed += 1;
        console.warn('migrate: unexpected record', path);
        continue;
      }
      if (isEnvelope(rec.value)) {
        skipped += 1;
        continue;
      }

      const plain = JSON.stringify(rec.value);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const envelope = {
        v: 1,
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        ct: ct.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };

      // Round-trip before touching the file.
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const back = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
        if (back !== plain) throw new Error('round-trip mismatch');
      } catch (e) {
        failed += 1;
        console.warn('migrate: encrypt check failed', path, String(e));
        continue;
      }

      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify({ key: rec.key, value: envelope }), 'utf8');
      await rename(tmp, path);
      encrypted += 1;
    }
  }

  console.log(JSON.stringify({ dir, collections: collections.length, encrypted, skipped, failed }));
  if (failed > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
