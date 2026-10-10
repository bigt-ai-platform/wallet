/**
 * Chain roles the discovery stack knows about, and the per-role identifiers
 * published by the operator (registry chain ids, DNS seed names).
 *
 * - `l0` — the main chain (escrow lock/release live here).
 * - `l1` — the order-match chain.
 * - `social` — L1-SOCIAL (chainId `SOCIAL`, `l1-social-server`): where the
 *   engine anchors `social.p2p-swap` records. Its DNS label
 *   (`_bigtangle-social`) is optional in the zone; when absent, discovery
 *   simply yields no DNS candidates for the role (fail closed).
 */
export type ChainRole = 'l0' | 'l1' | 'social';

/** Registry (`bigtangle-seeds` /serverinfolist) chain id per role. */
export const REGISTRY_CHAIN: Record<ChainRole, string> = {
  l0: 'L0',
  l1: 'ordermatch',
  social: 'SOCIAL',
};

/** TXT seed name for a role (`_bigtangle-l0.bigtangle.org`). */
export function dnsTxtName(role: ChainRole, domain: string): string {
  return `_bigtangle-${role}.${domain}`;
}

/** SRV seed name for a role (`_bigtangle-l0._tcp.bigtangle.org`). */
export function dnsSrvName(role: ChainRole, domain: string): string {
  return `_bigtangle-${role}._tcp.${domain}`;
}
