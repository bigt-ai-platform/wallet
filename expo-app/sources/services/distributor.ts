/**
 * Distributor / custodian adapter for **external assets** (`lib/externalAssets`).
 *
 * HKDAP is issued on Ethereum mainnet but held through an authorised
 * distributor, so the wallet never derives an Ethereum key for it and never
 * signs an Ethereum transaction: it asks the distributor to move the asset and
 * observes the result. This is the pattern `plan/hkd.md` §7.2 recommends
 * ("distributor/custodian API … no direct chain custody") and the same shape
 * `services/ethBridge.ts` already uses for issuer-credited deposits.
 *
 * ## What leaves the device
 *
 * Only the wallet address (as the account id), the asset id, an amount and a
 * recipient. **Never key material** — there is none for this rail. The bearer
 * token below is the user's distributor credential, stored in the device KV
 * store exactly like the server URLs in Settings.
 *
 * ## API contract
 *
 * The distributor endpoints are not yet specified by any vendor, so this module
 * defines the contract the wallet needs (all amounts are decimal strings of the
 * asset's smallest units, `assetId` from `lib/externalAssets`):
 *
 * ```
 * GET  {api}/balances?account=<addr>
 *   -> { items: [{ assetId, available, pending? }] }
 * GET  {api}/statement?account=<addr>&limit=<n>
 *   -> { items: [{ id, assetId, direction: 'in'|'out', amount,
 *                  status, at?, counterparty?, memo?, hash? }] }
 * POST {api}/transfers        { account, assetId, to, amount, memo? }
 * POST {api}/mint-requests    { account, assetId, amount, reference? }
 * POST {api}/redeem-requests  { account, assetId, amount, reference? }
 *   -> { id, status }
 * GET  {api}/transfers/<id>   -> { id, status }
 * ```
 *
 * `status` is `pending | processing | completed | failed`. A distributor that
 * settles on Ethereum should only report `completed` once the transfer is in a
 * finalized block (`settlementFinality: 'ethereum-finalized'`).
 */

import { device } from '@/storage';
import { isValidChecksumAddress, requireAddress } from '@/lib/eth/address';
import {
  findExternalAsset,
  parseExternalAmount,
  type DepositKind,
  type ExternalAsset,
} from '@/lib/externalAssets';
const KEY = ['external', 'distributor'];

/** Thrown when no distributor endpoint is configured yet. */
export const DISTRIBUTOR_NOT_CONFIGURED = 'DISTRIBUTOR_NOT_CONFIGURED';

const REQUEST_TIMEOUT_MS = 20_000;

export type ExternalStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DistributorSettings {
  /** Distributor REST base, e.g. `https://distributor.example/api`. */
  apiUrl: string;
  /** Bearer token the distributor issued to this user; empty when unauthenticated. */
  token: string;
  /**
   * Distributor-side account id. Empty means "use the wallet address", which is
   * what an allowlist-keyed distributor expects.
   */
  accountId: string;
}

export interface ExternalBalance {
  assetId: string;
  /** Smallest units, decimal string. */
  available: string;
  pending?: string;
}

export interface ExternalMovement {
  id: string;
  assetId: string;
  direction: 'in' | 'out';
  amount: string;
  status: ExternalStatus;
  at?: string;
  counterparty?: string;
  memo?: string;
  hash?: string;
}

export interface ExternalTransferRequest {
  account: string;
  assetId: string;
  /** Recipient in the form the asset declares (`evm-address` / `account-id`). */
  to: string;
  /** Display units; converted with the asset decimals before sending. */
  amount: string;
  memo?: string;
}

export interface ExternalOperationResult {
  id: string;
  status: ExternalStatus;
}

export type TransferValidationError = 'errAsset' | 'errAddress' | 'errAmount' | 'errAccount';

export function getDistributorSettings(): DistributorSettings {
  const raw = device.get(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DistributorSettings>;
      return {
        apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl.trim() : '',
        token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
        accountId: typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '',
      };
    } catch {
      /* fall through to defaults */
    }
  }
  return { apiUrl: '', token: '', accountId: '' };
}

export function setDistributorSettings(patch: Partial<DistributorSettings>): void {
  device.set(KEY, JSON.stringify({ ...getDistributorSettings(), ...patch }));
}

export function isDistributorConfigured(): boolean {
  return !!getDistributorSettings().apiUrl;
}

/** Account id used in queries: the configured override, else the wallet address. */
export function distributorAccount(walletAddress: string): string {
  return getDistributorSettings().accountId || walletAddress;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const settings = getDistributorSettings();
  if (!settings.apiUrl) throw new Error(DISTRIBUTOR_NOT_CONFIGURED);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${trimBase(settings.apiUrl)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Distributor API HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

const STATUSES: ExternalStatus[] = ['pending', 'processing', 'completed', 'failed'];

function status(v: unknown): ExternalStatus {
  return STATUSES.includes(v as ExternalStatus) ? (v as ExternalStatus) : 'pending';
}

/** Balances for every asset the distributor reports for this account. Unknown
 *  assets are dropped rather than rendered with a guessed symbol/decimals. */
export async function getExternalBalances(account: string): Promise<ExternalBalance[]> {
  const body = await request<{ items?: unknown[] }>(
    `/balances?account=${encodeURIComponent(account)}`
  );
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.flatMap((raw): ExternalBalance[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const asset = findExternalAsset(str(row.assetId));
    if (!asset) return [];
    const available = str(row.available);
    if (!available) return [];
    const pending = str(row.pending);
    return [{ assetId: asset.id, available, ...(pending ? { pending } : {}) }];
  });
}

/** Movements (deposits, transfers, mint/redeem settlements), newest first as
 *  returned by the distributor. */
export async function getExternalStatement(account: string, limit = 50): Promise<ExternalMovement[]> {
  const body = await request<{ items?: unknown[] }>(
    `/statement?account=${encodeURIComponent(account)}&limit=${Math.max(1, Math.min(200, limit))}`
  );
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.flatMap((raw): ExternalMovement[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const asset = findExternalAsset(str(row.assetId));
    const id = str(row.id);
    const amount = str(row.amount);
    const direction = row.direction === 'in' || row.direction === 'out' ? row.direction : null;
    if (!id || !amount || !direction || !asset) return [];
    return [{
      id,
      assetId: asset.id,
      direction,
      amount,
      status: status(row.status),
      ...(str(row.at) ? { at: str(row.at) } : {}),
      ...(str(row.counterparty) ? { counterparty: str(row.counterparty) } : {}),
      ...(str(row.memo) ? { memo: str(row.memo) } : {}),
      ...(str(row.hash) ? { hash: str(row.hash) } : {}),
    }];
  });
}

/** One listing as the distributor describes it. */
export interface ExternalCatalogEntry {
  assetId: string;
  /** Funding rail; falls back to the bundled registry value. */
  depositKind: DepositKind;
  /** Free-text funding instructions (bank account, vault, custody address). */
  depositInstructions?: string;
  /** For the EVM rail: the custody address to send to. */
  depositAddress?: string;
  /** Prefix of the payment reference the user must include. */
  referencePrefix?: string;
}

const DEPOSIT_KINDS: DepositKind[] = ['bank', 'vault', 'evm', 'l1'];

/**
 * Listings the distributor serves (`GET /assets`), merged over the bundled
 * registry so a new asset does not need an app release (design decision 7).
 *
 * Unknown ids are dropped and an unknown `depositKind` falls back to the
 * bundle: the client still owns the trust boundary, so a compromised or buggy
 * distributor cannot invent an asset or a rail.
 */
export async function getExternalCatalogEntries(): Promise<ExternalCatalogEntry[]> {
  const body = await request<{ items?: unknown[] }>('/assets');
  const items = Array.isArray(body?.items) ? body.items : [];
  const out: ExternalCatalogEntry[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const asset = findExternalAsset(str(row.assetId) || str(row.id));
    if (!asset || out.some((entry) => entry.assetId === asset.id)) continue;
    const kind = str(row.depositKind).toLowerCase() as DepositKind;
    out.push({
      assetId: asset.id,
      depositKind: DEPOSIT_KINDS.includes(kind) ? kind : asset.depositKind,
      ...(str(row.depositInstructions) ? { depositInstructions: str(row.depositInstructions) } : {}),
      ...(str(row.depositAddress) ? { depositAddress: str(row.depositAddress) } : {}),
      ...(str(row.referencePrefix) ? { referencePrefix: str(row.referencePrefix) } : {}),
    });
  }
  return out;
}

/** Asset ids only — the projection most callers want. */
export async function getExternalCatalog(): Promise<string[]> {
  return (await getExternalCatalogEntries()).map((entry) => entry.assetId);
}

/** Catalog entries resolved against the bundled registry, in server order. */
export async function getListedExternalAssets(): Promise<ExternalAsset[]> {
  return (await getExternalCatalog()).flatMap((id) => {
    const asset = findExternalAsset(id);
    return asset ? [asset] : [];
  });
}

/**
 * Validate a transfer locally before it costs a distributor round trip.
 * Returns a stable error code the screen translates, or null when valid.
 */
export function validateTransfer(
  req: Pick<ExternalTransferRequest, 'account' | 'assetId' | 'to' | 'amount'>
): TransferValidationError | null {
  if (!req.account) return 'errAccount';
  const asset = findExternalAsset(req.assetId);
  if (!asset) return 'errAsset';
  const to = req.to.trim();
  if (!to) return 'errAddress';
  // EIP-55: a mixed-case address that fails the checksum is a poisoned/mistyped
  // target — reject it rather than let the distributor send into the void.
  if (asset.destination === 'evm-address' && !isValidChecksumAddress(to)) return 'errAddress';
  try {
    if (parseExternalAmount(req.amount, asset) <= BigInt(0)) return 'errAmount';
  } catch {
    return 'errAmount';
  }
  return null;
}

function toSmallestUnits(asset: ExternalAsset, amount: string): string {
  return parseExternalAmount(amount, asset).toString();
}

/** Ask the distributor to transfer `asset` to `to`. */
export async function submitExternalTransfer(req: ExternalTransferRequest): Promise<ExternalOperationResult> {
  const asset = resolveAsset(req.assetId);
  const body = await request<Record<string, unknown>>('/transfers', {
    method: 'POST',
    body: JSON.stringify({
      account: req.account,
      assetId: asset.id,
      to: asset.destination === 'evm-address' ? requireAddress(req.to) : req.to.trim(),
      amount: toSmallestUnits(asset, req.amount),
      ...(req.memo?.trim() ? { memo: req.memo.trim() } : {}),
    }),
  });
  return readOperation(body);
}

/** Mint request (issuer-side operation; the distributor may require paperwork). */
export async function requestExternalMint(
  assetId: string,
  account: string,
  amount: string,
  reference?: string
): Promise<ExternalOperationResult> {
  return submitOperation('/mint-requests', resolution(assetId, account, amount, reference));
}

/** Redeem request: burn at the distributor, off-chain HKD at the bank leg. */
export async function requestExternalRedeem(
  assetId: string,
  account: string,
  amount: string,
  reference?: string
): Promise<ExternalOperationResult> {
  return submitOperation('/redeem-requests', resolution(assetId, account, amount, reference));
}

function resolution(assetId: string, account: string, amount: string, reference?: string) {
  const asset = resolveAsset(assetId);
  return {
    account,
    assetId: asset.id,
    amount: toSmallestUnits(asset, amount),
    ...(reference?.trim() ? { reference: reference.trim() } : {}),
  };
}

async function submitOperation(
  path: string,
  payload: Record<string, string>
): Promise<ExternalOperationResult> {
  const body = await request<Record<string, unknown>>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return readOperation(body);
}

/** Poll one operation (transfer, mint or redeem) by its distributor id. */
export async function getExternalOperation(id: string): Promise<ExternalOperationResult> {
  const body = await request<Record<string, unknown>>(`/transfers/${encodeURIComponent(id)}`);
  return readOperation(body);
}

function resolveAsset(assetId: string): ExternalAsset {
  const asset = findExternalAsset(assetId);
  if (!asset) throw new Error(`Unknown external asset: ${assetId}`);
  return asset;
}

function readOperation(body: Record<string, unknown> | null): ExternalOperationResult {
  const id = str(body?.id);
  if (!id) throw new Error('Distributor response is missing the operation id');
  return { id, status: status(body?.status) };
}
