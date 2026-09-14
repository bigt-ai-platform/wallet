import { Platform } from 'react-native';

/** App-wide constants shared across screens. */
export const APP_VERSION = '1.2.0';

/** True in development builds (Metro/Expo), false in production exports. */
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * True in the static web export. Browsers cannot call the public chain nodes
 * directly (their API has CORS disabled), so web production builds use the
 * same-origin /l0/ + /l1/ paths reverse-proxied by the deploy stack: the host
 * Caddy vhost (deploy/region.sh) and the in-container nginx fallback
 * (deploy/nginx.conf).
 */
const IS_WEB = Platform.OS === 'web';

/**
 * Local dev-server endpoints (dev.sh: L0 :24089, L1 :24086). Development
 * builds default here; production uses the PROD_* endpoints below.
 */
export const DEV_L0_URL = 'http://127.0.0.1:24089/';
export const DEV_L1_URL = 'http://127.0.0.1:24086/';

/**
 * Production network endpoints: the TLS entry points of the production
 * deployment (blockchain helper/prod/prod.sh + prod-order.sh, system Caddy
 * reverse proxies). These are the browser-reachable form of the network's
 * servers — the raw seeds in MainNetParams.serverSeeds() are plain http and
 * the production nodes send no CORS headers, so browsers can only reach the
 * network through these hosts (or, for the web build, a same-origin proxy).
 * The legacy m.bigtangle.org host serves the JSF webapp, not the JSON-RPC
 * order API.
 */
export const PROD_L0_URL = 'https://eu1.bigtangle.org';
export const PROD_L1_URL = 'https://ordereu1.bigtangle.org';

/**
 * Same-origin proxy bases served by the deploy stack for the web production
 * build (host Caddy from deploy/region.sh, fallback deploy/nginx.conf).
 * Requests go to <origin>/l0/... and are proxied to the PROD_* hosts, which
 * avoids both mixed content and CORS. Keep the upstreams in the deploy files
 * in sync with these paths.
 */
export const PROD_WEB_L0_BASE = '/l0/';
export const PROD_WEB_L1_BASE = '/l1/';

/** Testnet L1 (order match) endpoint (no web proxy — testnet is dev-only). */
export const DEFAULT_L1_TESTNET_URL = 'https://testm.bigtangle.org';

/** Mainnet L1 order-match URL for the current platform. */
export const DEFAULT_L1_MAINNET_URL = IS_WEB ? PROD_WEB_L1_BASE : PROD_L1_URL;

/** Default L1 (order match) chains per network. Each has a unique on-chain id. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_MAINNET_URL },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_TESTNET_URL },
];
