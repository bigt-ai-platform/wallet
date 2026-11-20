import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishAttestations } from '../src/attestation.js';
import { emptyStatusCounts, renderMetrics } from '../src/metrics.js';
import type { AttestationRecord } from '../src/domain.js';
import { MemoryStore } from '../src/store.js';

let store: MemoryStore;
let published: AttestationRecord[];

beforeEach(() => {
  store = new MemoryStore();
  published = [];
});

const publisher = { publish: async (record: AttestationRecord) => { published.push(record); } };
const hash = (input: string) => `h(${input})`;

describe('attestations', () => {
  it('publishes one record per reserve, versioned from 1', async () => {
    await store.putReserve({ assetId: 'hkd', reserveRaw: 100n, supplyRaw: 90n, dustRaw: 0n });
    await store.putReserve({ assetId: 'gold', reserveRaw: 200n, supplyRaw: 200n, dustRaw: 7n });

    const records = await publishAttestations({
      store, publisher, now: () => '2026-01-01T00:00:00.000Z', hash,
    });
    expect(records.map((r) => r.assetId)).toEqual(['hkd', 'gold']);
    expect(records.every((r) => r.version === 1)).toBe(true);
    expect(records[0].documentHash).toBe('h(hkd|1|100|90)');
    expect(records[1].documentHash).toBe('h(gold|1|200|200)');
    expect(published).toHaveLength(2);
    expect((await store.latestAttestation('hkd'))?.version).toBe(1);
  });

  it('increments the version on the next run', async () => {
    await store.putReserve({ assetId: 'hkd', reserveRaw: 100n, supplyRaw: 0n, dustRaw: 0n });
    const opts = { store, publisher, now: () => 't', hash };
    await publishAttestations(opts);
    await publishAttestations(opts);
    const latest = await store.latestAttestation('hkd');
    expect(latest?.version).toBe(2);
    expect(latest?.documentHash).toBe('h(hkd|2|100|0)');
  });

  it('publishes nothing when there is no reserve', async () => {
    expect(await publishAttestations({ store, publisher, now: () => 't', hash })).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe('metrics', () => {
  it('emits per-asset gauges and a global health line', () => {
    const text = renderMetrics(
      [
        { assetId: 'hkd', reserveRaw: 100n, supplyRaw: 100n, dustRaw: 0n },
        { assetId: 'gold', reserveRaw: 50n, supplyRaw: 40n, dustRaw: 3n },
      ],
      { ...emptyStatusCounts(), pending: 2, completed: 5 },
    );
    expect(text).toContain('asset_issuer_healthy 1');
    expect(text).toContain('asset_issuer_reserve_raw{asset="hkd"} 100');
    expect(text).toContain('asset_issuer_supply_raw{asset="gold"} 40');
    expect(text).toContain('asset_issuer_dust_raw{asset="gold"} 3');
    expect(text).toContain('asset_issuer_operations{status="pending"} 2');
    expect(text).toContain('asset_issuer_operations{status="completed"} 5');
  });

  it('flags unhealthy without hiding which asset broke', () => {
    const text = renderMetrics(
      [{ assetId: 'usd', reserveRaw: 10n, supplyRaw: 11n, dustRaw: 0n }],
      emptyStatusCounts(),
    );
    expect(text).toContain('asset_issuer_healthy 0');
    expect(text).toContain('asset_issuer_supply_raw{asset="usd"} 11');
  });

  it('escapes label values', () => {
    const text = renderMetrics(
      [{ assetId: 'we"ird', reserveRaw: 1n, supplyRaw: 1n, dustRaw: 0n }],
      emptyStatusCounts(),
    );
    expect(text).toContain('asset="we\\"ird"');
  });
});

describe('metrics route', () => {
  it('serves prometheus text and counts operations by status', async () => {
    const { buildServer } = await import('../src/server.js');
    const app = buildServer({ store });
    await store.putReserve({ assetId: 'hkd', reserveRaw: 100n, supplyRaw: 100n, dustRaw: 0n });
    await store.saveOperation({
      id: 'op1', kind: 'deposit', assetId: 'hkd', account: 'w1',
      amountRaw: '1', l1AmountRaw: '1', status: 'pending', attempts: 0,
      createdAt: 't', updatedAt: 't',
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('asset_issuer_operations{status="pending"} 1');
    expect(res.body).toContain('asset_issuer_healthy 1');
    await app.close();
  });
});
