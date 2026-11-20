/**
 * Prometheus text metrics.
 *
 * One line per asset — never an aggregate — because `supply <= reserve` is a
 * per-asset property and averaging it hides exactly the failure we care about.
 */

import { supplyWithinReserve, type OperationStatus, type ReserveEntry } from './domain.js';

export type StatusCounts = Record<OperationStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return { pending: 0, processing: 0, completed: 0, failed: 0 };
}

export function renderMetrics(reserves: ReserveEntry[], counts: StatusCounts): string {
  const lines: string[] = [];
  const healthy = reserves.every(supplyWithinReserve);

  lines.push('# HELP asset_issuer_healthy 1 when every asset satisfies supply <= reserve');
  lines.push('# TYPE asset_issuer_healthy gauge');
  lines.push(`asset_issuer_healthy ${healthy ? 1 : 0}`);

  lines.push('# HELP asset_issuer_reserve_raw External reserve, smallest L1 units');
  lines.push('# TYPE asset_issuer_reserve_raw gauge');
  for (const entry of reserves) {
    lines.push(`asset_issuer_reserve_raw{asset="${escape(entry.assetId)}"} ${entry.reserveRaw.toString()}`);
  }

  lines.push('# HELP asset_issuer_supply_raw Issued L1 supply, smallest units');
  lines.push('# TYPE asset_issuer_supply_raw gauge');
  for (const entry of reserves) {
    lines.push(`asset_issuer_supply_raw{asset="${escape(entry.assetId)}"} ${entry.supplyRaw.toString()}`);
  }

  lines.push('# HELP asset_issuer_dust_raw Conversion dust carried in the reserve');
  lines.push('# TYPE asset_issuer_dust_raw gauge');
  for (const entry of reserves) {
    lines.push(`asset_issuer_dust_raw{asset="${escape(entry.assetId)}"} ${entry.dustRaw.toString()}`);
  }

  lines.push('# HELP asset_issuer_operations Operations by status');
  lines.push('# TYPE asset_issuer_operations gauge');
  for (const status of Object.keys(counts) as OperationStatus[]) {
    lines.push(`asset_issuer_operations{status="${status}"} ${counts[status]}`);
  }

  return `${lines.join('\n')}\n`;
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
