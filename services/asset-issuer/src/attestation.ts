/**
 * Reserve attestations.
 *
 * Publishes the current `(reserve, supply)` snapshot per asset and stores the
 * hash of the off-chain statement (bank letter, bar list, proof of reserves).
 * The chain and the UI only ever see the hash — verification stays off-chain and
 * must not be presented as on-chain proof.
 *
 * One record per asset, never aggregated: a shortfall in one asset is not diluted
 * by a surplus in another.
 */

import { createHash } from 'node:crypto';
import type { AttestationRecord, ReserveEntry } from './domain.js';
import type { Store } from './store.js';

export interface AttestationPublisher {
  publish(record: AttestationRecord): Promise<void>;
}

export interface AttestationOptions {
  store: Store;
  publisher: AttestationPublisher;
  now: () => string;
  /** Defaults to sha256 hex; injectable for deterministic tests. */
  hash?: (input: string) => string;
}

export function statementHash(
  entry: ReserveEntry,
  version: number,
  hash: (input: string) => string = (input) => createHash('sha256').update(input).digest('hex'),
): string {
  return hash(`${entry.assetId}|${version}|${entry.reserveRaw.toString()}|${entry.supplyRaw.toString()}`);
}

export async function publishAttestations(options: AttestationOptions): Promise<AttestationRecord[]> {
  const { store, publisher, now } = options;
  const published: AttestationRecord[] = [];
  for (const entry of await store.listReserves()) {
    const previous = await store.latestAttestation(entry.assetId);
    const version = (previous?.version ?? 0) + 1;
    const record: AttestationRecord = {
      assetId: entry.assetId,
      version,
      reserveRaw: entry.reserveRaw,
      supplyRaw: entry.supplyRaw,
      documentHash: statementHash(entry, version, options.hash),
      publishedAt: now(),
    };
    await publisher.publish(record);
    await store.putAttestation(record);
    published.push(record);
  }
  return published;
}
