/**
 * In-app system messages.
 *
 * A tiny event bus for chain/system events that should be visible on whatever
 * page the user is looking at (for example a payment reaching finality). The
 * `SystemMessageHost` mounted by the root layout renders the queue as a page
 * banner; producers only describe the message.
 */

export type SystemMessageTone = 'info' | 'success' | 'error';

export interface SystemMessage {
  id: string;
  tone: SystemMessageTone;
  title: string;
  body?: string;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  ttlMs?: number;
  createdAt: number;
}

type Listener = (message: SystemMessage) => void;

const listeners = new Set<Listener>();
let seq = 0;

/** Publish a message to every mounted host. */
export function notifySystemMessage(input: Omit<SystemMessage, 'id' | 'createdAt'>): SystemMessage {
  const message: SystemMessage = {
    ...input,
    id: `sys_${Date.now().toString(36)}_${(seq++).toString(36)}`,
    createdAt: Date.now(),
  };
  for (const listener of Array.from(listeners)) {
    try {
      listener(message);
    } catch {
      // A broken consumer must not prevent other listeners from seeing it.
    }
  }
  return message;
}

/** Subscribe to system messages. Returns an unsubscribe function. */
export function subscribeSystemMessages(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
