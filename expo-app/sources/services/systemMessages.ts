/**
 * In-app system messages.
 *
 * A tiny event bus plus a persisted notification centre. Producers describe a
 * chain/system event; `SystemMessageHost` renders the live banner and the
 * Notifications page/Home card read the stored history and unread count.
 */

import { device } from '@/storage';

export type SystemMessageTone = 'info' | 'success' | 'error';

export interface SystemMessage {
  id: string;
  tone: SystemMessageTone;
  title: string;
  body?: string;
  /** Auto-dismiss the live banner after this many ms; 0 keeps it open. */
  ttlMs?: number;
  read?: boolean;
  createdAt: number;
}

type Listener = (message: SystemMessage) => void;
type ChangeListener = () => void;

const STORAGE_KEY: string[] = ['notifications', 'messages'];
const MAX_MESSAGES = 50;
const listeners = new Set<Listener>();
const changeListeners = new Set<ChangeListener>();
let seq = 0;
let cache: SystemMessage[] | null = null;

function readStored(): SystemMessage[] {
  if (cache) return cache;
  const raw = device.get(STORAGE_KEY);
  if (!raw) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed)
      ? parsed.filter((m): m is SystemMessage =>
        !!m && typeof m.id === 'string' && typeof m.title === 'string' && typeof m.createdAt === 'number')
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function emitChange(): void {
  for (const listener of Array.from(changeListeners)) {
    try {
      listener();
    } catch {
      // Keep the bridge independent of consumers.
    }
  }
}

function writeStored(messages: SystemMessage[]): void {
  cache = messages.slice(0, MAX_MESSAGES);
  device.set(STORAGE_KEY, JSON.stringify(cache));
  emitChange();
}

/** Persisted newest-first notification history. */
export function listSystemMessages(): SystemMessage[] {
  return readStored();
}

export function unreadSystemMessageCount(): number {
  return readStored().filter((m) => !m.read).length;
}

/** Mark one/all stored messages as read. */
export function markSystemMessagesRead(ids?: string[]): void {
  const wanted = ids ? new Set(ids) : null;
  const next = readStored().map((m) =>
    (!wanted || wanted.has(m.id)) && !m.read ? { ...m, read: true } : m);
  if (next.some((m, i) => m !== readStored()[i])) writeStored(next);
}

export function clearSystemMessages(): void {
  writeStored([]);
}

/** Subscribe to stored-history/unread changes (notification centre UI). */
export function subscribeSystemMessageChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Publish a message to the live banner and the persisted centre. */
export function notifySystemMessage(input: Omit<SystemMessage, 'id' | 'createdAt' | 'read'>): SystemMessage {
  const message: SystemMessage = {
    ...input,
    id: `sys_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    createdAt: Date.now(),
    read: false,
  };
  writeStored([message, ...readStored()]);
  for (const listener of Array.from(listeners)) {
    try {
      listener(message);
    } catch {
      // A broken consumer must not prevent other listeners from seeing it.
    }
  }
  return message;
}

/** Subscribe to newly published messages (the live banner). */
export function subscribeSystemMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
