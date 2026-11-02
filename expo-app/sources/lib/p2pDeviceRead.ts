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

/** A buyer may turn to device evidence once the seller is this late. */
export const DEVICE_VERIFY_AFTER_MS = 30 * 60 * 1000;

/**
 * When to offer the buyer's device check (docs/p2p.md §12). It is optional
 * evidence, never a normal-flow step: only a buyer on a rail with a payer-side
 * read (Alipay / bank), only after a payment claim, and only once the seller is
 * 30 minutes late on the release or a dispute is open.
 */
export function deviceVerifyDue(
  swap: { wantRail?: string; status: string; paidAt?: number; dispute?: string },
  side: 'buyer' | 'seller',
  now: number = Date.now(),
): boolean {
  if (side !== 'buyer') return false;
  if (deviceReadMode(swap.wantRail, 'buyer') === null) return false;
  if (swap.status !== 'PAYMENT_CLAIMED' && swap.status !== 'PAYMENT_VERIFIED') return false;
  if (swap.dispute) return true;
  return typeof swap.paidAt === 'number' && now - swap.paidAt >= DEVICE_VERIFY_AFTER_MS;
}
