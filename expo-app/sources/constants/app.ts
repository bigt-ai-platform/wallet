import { Platform } from 'react-native';

/** App-wide constants shared across screens. */
export const APP_VERSION = '1.2.0';

/** True in development builds (Metro/Expo), false in production exports. */
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * True in the static web export. The browser cannot call the public chain
 * nodes directly (their API has CORS disabled), so L0/L1 requests go through
 * the same-origin /l0/ + /l1/ paths reverse-proxied by the deploy Caddy
 * vhosts (deploy/region.sh) to the public HTTPS nodes.
 */
const IS_WEB = Platform.OS === 'web';

/**
 * Local dev-server endpoints (dev.sh: L0 :24089, L1 :24086). Development
 * builds default here; production discovers L0 from the network seeds and
 * uses the configured L1 order-match endpoints.
 */
export const DEV_L0_URL = 'http://127.0.0.1:24089/';
export const DEV_L1_URL = 'http://127.0.0.1:24086/';

/**
 * Mainnet L1 (order match) endpoint. Native builds call the public HTTPS
 * order node directly; the web build uses the same-origin /l1/ proxy.
 * NOTE: the legacy `m.bigtangle.org` host serves the JSF webapp, not the
 * JSON-RPC order API — never use it here.
 */
export const DEFAULT_L1_MAINNET_URL = IS_WEB ? '/l1/' : 'https://ordereu1.bigtangle.org';

/** Testnet L1 (order match) endpoint (no web proxy — testnet is dev-only). */
export const DEFAULT_L1_TESTNET_URL = 'https://testm.bigtangle.org';

/** Default L1 (order match) chains per network. Each has a unique on-chain id. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_MAINNET_URL },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_TESTNET_URL },
];
