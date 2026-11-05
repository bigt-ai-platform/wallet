import * as React from 'react';
import { device } from '@/storage';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { listPayments } from '@/services/tracking';
import { notifySystemMessage } from '@/services/systemMessages';
import { decimalsFor, formatTokenAmount } from '@/lib/tokenformat';
import i18n from '@/lib/i18n';

const POLL_MS = 30000;
const STORAGE_KEY: string[] = ['notifications', 'incoming'];
const MAX_SEEN = 300;
/** How far before the last poll to re-scan (chain indexing lags a little). */
const LOOKBACK_SEC = 600;
/** At most this many notices per tick; the rest are marked seen silently. */
const MAX_NOTICES = 5;

interface IncomingState {
  /** `${txHash}|${tokenId}` keys already surfaced (or seeded). */
  seen: string[];
  /** Epoch seconds of the last successful poll; null = never seeded. */
  lastTime: number | null;
}

function readState(): IncomingState {
  const raw = device.get(STORAGE_KEY);
  if (!raw) return { seen: [], lastTime: null };
  try {
    const parsed = JSON.parse(raw) as Partial<IncomingState>;
    return {
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((k): k is string => typeof k === 'string') : [],
      lastTime: typeof parsed.lastTime === 'number' ? parsed.lastTime : null,
    };
  } catch {
    return { seen: [], lastTime: null };
  }
}

function writeState(state: IncomingState): void {
  device.set(STORAGE_KEY, JSON.stringify({ seen: state.seen.slice(-MAX_SEEN), lastTime: state.lastTime }));
}

interface Incoming {
  key: string;
  txHash: string;
  token: string;
  raw: bigint;
  time: number;
}

/**
 * App-wide **incoming** payment watcher (the counterpart of the outgoing
 * payment finality notices in `tracking.ts`). It scans this wallet's L0
 * output history for confirmed outputs addressed to it and raises a
 * "Payment received" system message once per transaction/token.
 *
 * The first run only seeds the baseline (now), so installing the app does not
 * replay the wallet's whole history as notifications; later runs notify for
 * anything received since the previous poll, including while the app was
 * closed. Transactions this wallet sent are skipped (their change output is
 * not an incoming payment), as are coinbase outputs.
 */
export default function IncomingPaymentWatcher() {
  const { publicInfo } = useWallet();
  const address = publicInfo?.address;

  React.useEffect(() => {
    if (!address) return undefined;
    let disposed = false;
    let inFlight = false;
    let state = readState();

    const tick = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const now = Math.floor(Date.now() / 1000);
        if (state.lastTime === null) {
          // First run: baseline only, never spam the wallet's past.
          state = { seen: [], lastTime: now };
          writeState(state);
          return;
        }
        const res = await httpService.getOutputsHistory({
          toAddress: address,
          fromTime: Math.max(0, state.lastTime - LOOKBACK_SEC),
        });
        if (disposed) return;
        if (!res.success || !res.data) return;

        const seen = new Set(state.seen);
        const outgoing = new Set(
          listPayments()
            .map((p) => p.txHash)
            .filter((h): h is string => typeof h === 'string' && h.length > 0),
        );
        const byKey = new Map<string, Incoming>();
        for (const row of res.data as unknown as Array<Record<string, unknown>>) {
          if (row.confirmed !== true || row.coinbase === true) continue;
          const coin = row.value as { value?: unknown; tokenHex?: unknown } | unknown;
          const rawValue = coin && typeof coin === 'object'
            ? (coin as { value?: unknown }).value
            : coin;
          const token = String(
            row.tokenId ??
            row.tokenid ??
            (coin && typeof coin === 'object' ? (coin as { tokenHex?: unknown }).tokenHex : '') ??
            '',
          );
          const txHash = String(row.hashHex ?? row.txhash ?? '');
          const from = String(row.fromaddress ?? '');
          if (!txHash || !token) continue;
          // Changes/self-transfers are not received payments.
          if (from.toLowerCase() === address.toLowerCase()) continue;
          if (outgoing.has(txHash)) continue;
          let raw: bigint;
          try {
            raw = BigInt(String(rawValue ?? '0'));
          } catch {
            continue;
          }
          if (raw <= 0n) continue;
          const key = `${txHash}|${token}`;
          if (seen.has(key)) continue;
          const existing = byKey.get(key);
          if (existing) {
            existing.raw += raw;
          } else {
            byKey.set(key, {
              key,
              txHash,
              token,
              raw,
              time: Number(row.time ?? 0) || now,
            });
          }
        }

        if (byKey.size > 0) {
          const incoming = [...byKey.values()].sort((a, b) => b.time - a.time);
          incoming.forEach((item, index) => {
            // Only the newest few announce; the rest are recorded silently so a
            // long offline period does not flood the banner.
            if (index < MAX_NOTICES) {
              const tokenName = item.token === 'bc' ? 'BIG' : item.token.slice(0, 8);
              notifySystemMessage({
                tone: 'success',
                title: i18n.t('system.paymentReceivedTitle'),
                body: i18n.t('system.paymentReceivedBody', {
                  amount: formatTokenAmount(item.raw, decimalsFor(item.token)),
                  token: tokenName,
                  hash: `${item.txHash.slice(0, 12)}…`,
                }),
              });
            }
            seen.add(item.key);
          });
        }
        state = { seen: [...seen], lastTime: now };
        writeState(state);
      } catch {
        // Best-effort; the next tick retries from the same baseline.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [address]);

  return null;
}
