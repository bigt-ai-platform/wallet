/**
 * Payment & Order Tracking
 *
 * Records every payment (L0 token transfer) and every market order placed by
 * the user and tracks its lifecycle status on the chain:
 *
 *   - payments: queried via the L0 `getTransactionStatus` endpoint
 *     (MEMPOOL → BATCHED → IN_BLOCK → SOLID → CONFIRMED, or DROPPED)
 *   - orders:   queried via the L1 `getOrders` endpoint by address
 *     (open orders are pending; filled orders become confirmed; cancelled are
 *     marked cancelled)
 *
 * Records are persisted locally (MMKV / localStorage on web) so the status is
 * available even after the app restarts.
 */

import { device } from '@/storage';
import { httpService } from './http';
import type { OrderInfo, TrackedRecord, TrackedStatus, TransactionStatusInfo } from '@/types/api';

const STORAGE_KEY: string[] = ['tracking', 'records'];
const MAX_RECORDS = 200;

export interface RecordPaymentParams {
  txHash: string;
  tokenId: string;
  tokenName: string;
  amount: string;
  decimals?: number;
  fromAddress: string;
  toAddress: string;
  memo?: string;
  /** Layer the payment was submitted to: 0 = L0, 1..N = configured L1 chains. */
  layer?: number;
}

export interface RecordOrderParams {
  side: 'buy' | 'sell';
  tokenId: string;
  tokenName: string;
  baseToken: string;
  price: string;
  amount: string;
  decimals?: number;
  fromAddress: string;
  txHash?: string;
}

function readAll(): TrackedRecord[] {
  const raw = device.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(records: TrackedRecord[]): void {
  device.set(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
}

function upsert(record: TrackedRecord): TrackedRecord[] {
  const records = readAll();
  const index = records.findIndex((r) => r.id === record.id);
  if (index >= 0) {
    records[index] = record;
  } else {
    records.unshift(record);
  }
  writeAll(records);
  return records;
}

function makeId(kind: TrackedRecord['kind'], txHash?: string): string {
  const suffix = txHash ? txHash.slice(0, 16) : `${Date.now().toString(36)}`;
  return `${kind}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listPayments(): TrackedRecord[] {
  return readAll().filter((r) => r.kind === 'payment');
}

export function listOrders(): TrackedRecord[] {
  return readAll().filter((r) => r.kind === 'order');
}

export function getAllRecords(): TrackedRecord[] {
  return readAll();
}

export function getRecordById(id: string): TrackedRecord | undefined {
  return readAll().find((r) => r.id === id);
}

/**
 * Record a payment that was successfully broadcast.
 */
export function recordPayment(params: RecordPaymentParams): TrackedRecord {
  const now = Date.now();
  const record: TrackedRecord = {
    id: makeId('payment', params.txHash),
    kind: 'payment',
    txHash: params.txHash,
    tokenId: params.tokenId,
    tokenName: params.tokenName,
    amount: params.amount,
    decimals: params.decimals,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    memo: params.memo,
    layer: params.layer,
    status: 'pending',
    statusDetail: 'MEMPOOL',
    createdAt: now,
    updatedAt: now,
  };
  upsert(record);
  return record;
}

/**
 * Record an order that was successfully submitted to the L1 order chain.
 */
export function recordOrder(params: RecordOrderParams): TrackedRecord {
  const now = Date.now();
  const record: TrackedRecord = {
    id: makeId('order', params.txHash),
    kind: 'order',
    txHash: params.txHash,
    tokenId: params.tokenId,
    tokenName: params.tokenName,
    amount: params.amount,
    decimals: params.decimals,
    side: params.side,
    price: params.price,
    baseToken: params.baseToken,
    fromAddress: params.fromAddress,
    status: 'pending',
    statusDetail: 'SUBMITTED',
    createdAt: now,
    updatedAt: now,
  };
  upsert(record);
  return record;
}

function updateRecord(id: string, patch: Partial<TrackedRecord>): TrackedRecord | undefined {
  const records = readAll();
  const index = records.findIndex((r) => r.id === id);
  if (index < 0) return undefined;
  records[index] = { ...records[index], ...patch, updatedAt: Date.now() };
  writeAll(records);
  return records[index];
}

/**
 * Map a raw chain status string to a normalized tracked status.
 */
export function mapChainTxStatus(status: string): TrackedStatus {
  switch (status) {
    case 'CONFIRMED':
      return 'confirmed';
    case 'DROPPED':
      return 'failed';
    case 'MEMPOOL':
    case 'BATCHED':
    case 'IN_BLOCK':
    case 'SOLID':
      return 'pending';
    default:
      // UNKNOWN / not yet indexed — keep as pending
      return 'pending';
  }
}

/**
 * Refresh a single pending payment against the L0 transaction status API.
 *
 * The single-validator test beacon chain can briefly reorg a just-confirmed
 * block, dropping the transaction back to BATCHED for a few seconds. A single
 * status fetch could stick the record at "pending" even though the payment
 * confirmed — retry a couple of times so a transient dip does not get stuck.
 */
async function refreshPayment(record: TrackedRecord): Promise<TrackedRecord> {
  if (!record.txHash) return record;
  // The single-validator test beacon chain can briefly reorg a just-confirmed
  // block, dropping the transaction back to BATCHED for several seconds. Poll
  // for up to ~14s so a transient dip does not stick the record at "pending"
  // even though the payment confirmed (the tracking test expects the status to
  // flip within 15s of a refresh).
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await httpService.getTransactionStatus(record.txHash);
    if (res.success && res.data) {
      const info: TransactionStatusInfo = res.data;
      const next = mapChainTxStatus(info.status);
      const updated = updateRecord(record.id, {
        status: next,
        statusDetail: info.status,
      });
      if (next !== 'pending') {
        return updated || record;
      }
    }
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return record;
}

/**
 * Refresh tracked orders against the live L1 order book for the address.
 * Orders still open on the chain stay pending; orders that are cancelled show
 * cancelled; orders no longer in the open book are considered filled.
 *
 * When an order record has a txHash, first poll the L1 transaction lifecycle
 * status (MEMPOOL/IN_BLOCK/SOLID/CONFIRMED/DROPPED) on {@code l1Url}; a
 * confirmed transaction then falls through to the open-book check, while a
 * dropped one is marked failed.
 */
async function refreshOrders(address: string, l1Url?: string): Promise<TrackedRecord[]> {
  const res = await httpService.getOrdersByAddress(address);
  if (!res.success || !res.data) return listOrders();

  const openOrders: OrderInfo[] = res.data;
  const updated: TrackedRecord[] = [];

  for (const record of listOrders()) {
    if (record.kind !== 'order' || record.status !== 'pending') continue;

    // If we have a txHash and an L1 URL, check the transaction lifecycle first.
    if (record.txHash && l1Url) {
      const txRes = await httpService.getTransactionStatusOnChain(record.txHash, l1Url);
      if (txRes.success && txRes.data) {
        const chainStatus = txRes.data.status;
        if (chainStatus === 'DROPPED') {
          const next = updateRecord(record.id, { status: 'failed', statusDetail: 'DROPPED' });
          updated.push(next || record);
          continue;
        }
        // MEMPOOL/IN_BLOCK/SOLID/CONFIRMED all count as on-chain: keep going so
        // the open-book check below refines the final order state.
      }
    }

    const onChain = openOrders.find(
      (o) =>
        o.offerTokenid === record.tokenId &&
        (o.side || '').toUpperCase() === (record.side || '').toUpperCase()
    );

    if (!onChain) {
      // No longer in the open order book → filled/executed
      const next = updateRecord(record.id, { status: 'confirmed', statusDetail: 'FILLED' });
      updated.push(next || record);
    } else if (onChain.cancelPending) {
      const next = updateRecord(record.id, { status: 'cancelled', statusDetail: 'CANCELLED' });
      updated.push(next || record);
    } else {
      const next = updateRecord(record.id, { status: 'pending', statusDetail: 'OPEN' });
      updated.push(next || record);
    }
  }

  return updated.length ? updated : listOrders();
}

/**
 * Refresh the status of all pending payments and orders.
 */
export async function refreshAllStatuses(address?: string, l1Url?: string): Promise<TrackedRecord[]> {
  const payments = listPayments().filter((r) => r.status === 'pending');
  await Promise.all(payments.map((r) => refreshPayment(r)));
  if (address) {
    await refreshOrders(address, l1Url);
  }
  return getAllRecords();
}
