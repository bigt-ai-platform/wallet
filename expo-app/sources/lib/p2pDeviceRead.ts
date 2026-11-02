/**
 * How the engine can read this rail for this side (docs/p2p.md §12). WeChat
 * hides its screen from the accessibility service, so only the payee's
 * "payment received" notification is readable — a WeChat buyer has nothing to
 * read (null).
 */
export function deviceReadMode(rail: string | undefined, side: 'buyer' | 'seller'): 'screen' | 'notification' | null {
  if (rail === 'wechat') return side === 'seller' ? 'notification' : null;
  // PayPal has no accessibility/notification bridge yet; manual confirmation
  // and dispute remain the evidence path.
  if (rail === 'paypal') return null;
  return 'screen';
}

/** Whether the engine has a device-read bridge for this rail at all. */
export function deviceReadSupported(rail: string | undefined): boolean {
  return deviceReadMode(rail, 'seller') !== null || deviceReadMode(rail, 'buyer') !== null;
}
