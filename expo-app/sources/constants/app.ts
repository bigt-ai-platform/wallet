/** App-wide constants shared across screens. */
export const APP_VERSION = '1.2.0';

/** True in development builds (Metro/Expo), false in production exports. */
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

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
 */
export const PROD_L0_URL = 'https://eu1.bigtangle.org';
export const PROD_L1_URL = 'https://ordereu1.bigtangle.org';

/**
 * Same-origin proxy bases served by deploy/nginx.conf (web production builds
 * only). Requests go to <origin>/l0/... and are proxied to the PROD_* hosts,
 * which avoids both mixed content and CORS. Keep the upstreams in
 * deploy/nginx.conf in sync with these paths.
 */
export const PROD_WEB_L0_BASE = '/l0';
export const PROD_WEB_L1_BASE = '/l1';

/** Default L1 (order match) chains per network. Each has a unique on-chain id. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : PROD_L1_URL },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : 'https://testm.bigtangle.org' },
];
