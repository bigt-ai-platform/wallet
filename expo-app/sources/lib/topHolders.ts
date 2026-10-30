/**
 * Address rich list ("top holders") of one token.
 *
 * The server has no rich-list query: `outputsOfTokenid` returns every open
 * (unspent) output of a token and the client has to sum them per address. This
 * mirrors the Java reference `WalletService.searchTotalNoSave()` /
 * `RemoteTokenAddres.searchTotalNoSave()`, which accumulates
 * `utxo.value.value` (raw smallest unit) per `utxo.address`.
 */
import { toBigInt } from './amountformat';

/** Number of addresses the public balance page lists when none is entered. */
export const TOP_HOLDERS_LIMIT = 50;

/** One row of the rich list: raw summed amount of a single address. */
export interface HolderTotal {
  address: string;
  /** Raw amount in the token's smallest unit (BigInt, exact). */
  total: bigint;
  /** Number of open outputs that make up the total. */
  count: number;
}

/** An `outputsOfTokenid` row: `value` is the Java `Coin` object on the wire. */
export interface TokenOutput {
  address?: string;
  value?: unknown;
}

/**
 * Sum open outputs per address and return the largest holders, descending.
 * `value` may be the server's `Coin` object (`{ value: "..." }`) or already a
 * raw scalar. Rows without an address or with a non-positive amount are
 * ignored; ties are ordered by address so the list is deterministic.
 */
export function sumByAddress(
  outputs: readonly TokenOutput[],
  limit: number = TOP_HOLDERS_LIMIT,
): HolderTotal[] {
  const byAddress = new Map<string, HolderTotal>();
  for (const output of outputs ?? []) {
    const address = (output?.address ?? '').trim();
    if (!address) continue;
    const raw =
      output.value && typeof output.value === 'object'
        ? (output.value as { value?: unknown }).value
        : output.value;
    const amount = toBigInt(raw);
    if (amount <= 0n) continue;
    const current = byAddress.get(address) ?? { address, total: 0n, count: 0 };
    current.total += amount;
    current.count += 1;
    byAddress.set(address, current);
  }
  const sorted = Array.from(byAddress.values()).sort((a, b) =>
    a.total === b.total ? a.address.localeCompare(b.address) : a.total > b.total ? -1 : 1,
  );
  return limit >= 0 ? sorted.slice(0, limit) : sorted;
}
