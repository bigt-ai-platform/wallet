/**
 * How the engine can read this rail for this side (docs/p2p.md §12). WeChat
 * hides its screen from the accessibility service, so only the payee's
 * "payment received" notification is readable — a WeChat buyer has nothing to
 * read (null).
 */
export function deviceReadMode(rail: string | undefined, side: 'buyer' | 'seller'): 'screen' | 'notification' | null {
  if (rail === 'wechat') return side === 'seller' ? 'notification' : null;
  return 'screen';
}
