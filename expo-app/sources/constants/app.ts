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
 * Mainnet TLS entry points probed for the freshest/lowest-latency node (see
 * services/discovery.ts). eu1 is the historical primary; eu2/eu3 are the other
 * validator failure domains. Native builds probe these directly; the web build
 * cannot (CORS/mixed content) and uses the same-origin proxy instead.
 */
export const MAINNET_L0_URLS = [
  'https://eu1.bigtangle.org',
  'https://eu2.bigtangle.org',
  'https://eu3.bigtangle.org',
];
export const MAINNET_L1_URLS = [
  'https://ordereu1.bigtangle.org',
  'https://ordereu2.bigtangle.org',
  'https://ordereu3.bigtangle.org',
];

/**
 * DNS is only the bootstrap for the *seed* set. Ops publishes
 * `_bigtangle-l0[l1]` TXT/SRV records under this domain and the app resolves
 * them via DNS-over-HTTPS (WebView/RN cannot query SRV/TXT directly). The
 * static MAINNET_* lists above are the fallback when DNS yields nothing.
 */
export const DOH_URL = process.env.EXPO_PUBLIC_DOH_URL || 'https://dns.google/resolve';
export const DNS_SEEDS_DOMAIN = process.env.EXPO_PUBLIC_DNS_SEEDS_DOMAIN || 'bigtangle.org';

/**
 * bigtangle-seeds registries (plain JSON `POST /serverinfolist`) for live node
 * discovery, so the compiled `MAINNET_*` seeds are only a fallback. Must be a
 * TLS URL reachable from the app (e.g. a wallet-domain `/seeds/` proxy) — an
 * `http://` registry is blocked by the WebView/Android cleartext policy.
 */
export const SEEDS_URLS = (process.env.EXPO_PUBLIC_SEEDS_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const SEEDS_CHAIN_L0 = 'L0';
export const SEEDS_CHAIN_L1 = 'ordermatch';

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

/**
 * OTA release updates (Android APK only). The release bucket is public-read, so
 * the app fetches `wallet-<channel>-<type>-latest.json` directly and the
 * manifest's `url` is the APK object. `OTA_CHANNEL` is baked at build time by
 * deploy.apk.sh (EXPO_PUBLIC_APK_ENV); both can be overridden for testing.
 */
export const OTA_BASE =
  process.env.EXPO_PUBLIC_OTA_BASE || 'https://minio-s1001.bigt.ai/aifeeds-content/releases';
export const OTA_CHANNEL = process.env.EXPO_PUBLIC_APK_ENV || 'production';
export const OTA_TYPE = 'release';

/** Mainnet L1 order-match URL for the current platform. */
export const DEFAULT_L1_MAINNET_URL = IS_WEB ? PROD_WEB_L1_BASE : PROD_L1_URL;

/** Default L1 (order match) chains per network. Each has a unique on-chain id. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_MAINNET_URL },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_TESTNET_URL },
];
