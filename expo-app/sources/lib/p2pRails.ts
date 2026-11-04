/**
 * Payment-rail display names (P2P fiat rails).
 *
 * The engine and the wire records identify a rail by its protocol id
 * (`wechat`, `alipay`, `bank`, `paypal`). Those ids are not user-facing text —
 * showing them raw leaves the UI in lowercase English in every language — so
 * every surface renders them through this one mapping. Brand names (WeChat,
 * Alipay, PayPal) stay as-is outside Chinese; the generic bank rail is
 * translated.
 *
 * Unknown ids fall through unchanged so a future rail still renders something
 * sensible instead of an empty string.
 */
export const RAIL_I18N_KEYS: Record<string, string> = {
  wechat: 'p2p.railWechat',
  alipay: 'p2p.railAlipay',
  bank: 'p2p.railBank',
  paypal: 'p2p.railPaypal',
};

/** Localized rail name, e.g. `wechat` → 微信 / WeChat / Bank → 銀行. */
export function railLabel(t: (key: string) => string, rail: string): string {
  const key = RAIL_I18N_KEYS[rail];
  return key ? t(key) : rail;
}
