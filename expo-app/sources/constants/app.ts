import { Platform } from 'react-native';
import { isCapacitorNative } from '@/lib/platform';
import { nodeNames, proxyBaseForNode } from '@/lib/chainstatus';
import { p2pEngineUrl } from '@/lib/p2pEngineUrl';

/**
 * App version shown in Settings/About. Baked at build time from the release
 * tag (`EXPO_PUBLIC_APP_VERSION`, set by webapp.sh / deploy/tag.sh); the
 * fallback only applies to dev/e2e builds with no tag. The OTA check itself
 * uses the native Android versionCode, not this value.
 */
export const APP_VERSION = process.env.EXPO_PUBLIC_APP_VERSION || '1.0.0';

/** True in development builds (Metro/Expo), false in production exports. */
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * e2e-only: `e2e/e2etest.sh` builds the web export with
 * `EXPO_PUBLIC_E2E_AUTOCONFIRM=1` so the Playwright specs can approve an
 * important transaction (pay/order/p2p) without a device-unlock or password
 * prompt. Never set by a shipped build (APK/OTA), where the gate always runs.
 */
export const E2E_AUTOCONFIRM = process.env.EXPO_PUBLIC_E2E_AUTOCONFIRM === '1';

/**
 * True only in a genuine browser running the static web export. Browsers
 * cannot call the public chain nodes directly (their API has CORS disabled),
 * so web production builds use the same-origin /l0/ + /l1/ paths
 * reverse-proxied by the deploy stack: the host Caddy vhost (deploy/region.sh)
 * and the in-container nginx fallback (deploy/nginx.conf).
 *
 * The Capacitor Android app also reports Platform.OS === 'web' (its UI is the
 * web export) but is served from a local asset server with no such proxy, so
 * it must use the direct network endpoints like a native build.
 */
export const IS_WEB_BROWSER = Platform.OS === 'web' && !isCapacitorNative();

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
/**
 * Private group API relay (../apiserver; s1002.bigt.ai = 92.5.34.128).
 * Censorship-resistance default: native builds pin this IP (no DNS needed),
 * the relay's ALLOW_IPS gates who may use it, and the auto-discovery
 * candidate lists default to it (MAINNET_*_URLS below), so discovery keeps
 * the wallet on the relay. The web build keeps the same-origin /l0/ + /l1/
 * proxies below. Per-device override: Settings → Server URL / L1 URL.
 */
export const PRIVATE_API_BASE = 'https://92.5.34.128';
export const PRIVATE_L0_URL = `${PRIVATE_API_BASE}/l0/`;
export const PRIVATE_L1_URL = `${PRIVATE_API_BASE}/l1/`;

export const PROD_L0_URL = PRIVATE_L0_URL;
export const PROD_L1_URL = PRIVATE_L1_URL;

/**
 * Public P2P settlement-engine base, for native builds. The deploy stack
 * (deploy/region.sh config_caddy) routes `<domain>/p2p/*` to the shared engine
 * and strips the prefix, so this is the direct-network form of the web build's
 * same-origin `/p2p`. The apex vhost (`wallet.bigt.ai`, APEX_REGION) serves it.
 * The Capacitor app performs `fetch` natively (CapacitorHttp), so this
 * cross-origin call needs no `CORS_ORIGIN` entry for the WebView.
 */
export const PROD_P2P_URL = 'https://wallet.bigt.ai/p2p';

/**
 * Candidate set probed by auto-discovery (default ON, see
 * services/discovery.ts): the private relay only, so a censored client is
 * never steered onto the blocked public seeds.
 */
export const MAINNET_L0_URLS = [PRIVATE_L0_URL];
export const MAINNET_L1_URLS = [PRIVATE_L1_URL];

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

/**
 * Per-node same-origin proxy paths for the web production build (the browser
 * can only reach the chain through the Caddy `/l0/`+`/l1/` proxy, which maps
 * the default paths to the primary node and these per-node paths to each
 * mainnet node). Used by the sidebar "Chains" page so it lists the live nodes
 * under their own names. The names/addresses come from `lib/chainstatus.ts`
 * (MAINNET_NODES) and must stay in sync with the `handle_path` blocks in
 * deploy/region.sh and the `location` blocks in deploy/nginx.conf.
 */
export const PROD_WEB_L0_NODES = nodeNames('l0').map((name) => ({
  name,
  url: proxyBaseForNode('l0', name),
}));
export const PROD_WEB_L1_NODES = nodeNames('l1').map((name) => ({
  name,
  url: proxyBaseForNode('l1', name),
}));

/** Testnet L1 (order match) endpoint (no web proxy — testnet is dev-only). */
export const DEFAULT_L1_TESTNET_URL = 'https://testm.bigtangle.org';

/**
 * OTA release updates (Android APK only). The release bucket is public-read, so
 * the app fetches `wallet-<channel>-<type>-latest.json` directly and the
 * manifest's `url` is the APK object. `OTA_CHANNEL` is baked at build time by
 * deploy.apk.sh (EXPO_PUBLIC_APK_ENV); both can be overridden for testing.
 */
export const OTA_BASE =
  process.env.EXPO_PUBLIC_OTA_BASE || 'https://s3.bigt.ai/apps/wallet/apk';
export const OTA_CHANNEL = process.env.EXPO_PUBLIC_APK_ENV || 'production';
export const OTA_TYPE = 'release';

/** Mainnet L1 order-match URL for the current platform. */
export const DEFAULT_L1_MAINNET_URL = IS_WEB_BROWSER ? PROD_WEB_L1_BASE : PROD_L1_URL;

/**
 * Prediction-chain URL (l1-prediction-server, docs/prediction-market.md).
 *
 * The prediction chain is its OWN L1 node — never the L1-order node. The web
 * build reaches it through a same-origin proxy (`/l1p/`, deployed by
 * deploy/region.sh + deploy/nginx.conf because the nodes send no CORS); native
 * builds use the public prediction entry point (the private relay has no
 * prediction route). Dev keeps pointing at remote.sh's L1P port.
 */
export const PROD_WEB_PREDICTION_BASE = '/l1p/';
export const PROD_PREDICTION_URL = 'https://predicteu1.bigtangle.org/';
export const DEV_PREDICTION_URL = 'http://127.0.0.1:24088/';
export const DEFAULT_PREDICTION_URL = IS_WEB_BROWSER ? PROD_WEB_PREDICTION_BASE : PROD_PREDICTION_URL;

/** Default L1 (order match) chains per network. Each has a unique on-chain id. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_MAINNET_URL },
  { chainId: 'prediction', name: IS_DEV ? 'Local Predict' : 'Predict', url: IS_DEV ? DEV_PREDICTION_URL : DEFAULT_PREDICTION_URL },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { chainId: 'ordermatch', name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : DEFAULT_L1_TESTNET_URL },
  { chainId: 'prediction', name: IS_DEV ? 'Local Predict' : 'Predict Test', url: IS_DEV ? DEV_PREDICTION_URL : DEFAULT_L1_TESTNET_URL },
];

/**
 * P2P settlement engine base URL (services/p2p-engine).
 *
 * - dev: the local engine (webapp.sh --with-p2p reverses its port);
 * - web production: `EXPO_PUBLIC_P2P_ENGINE_URL` baked at build time
 *   (deploy/tag.sh sets the same-origin `/p2p`, proxied by the deploy stack's
 *   Caddy/nginx) — empty when unset, which the P2P screen shows as
 *   not-configured (e2e relies on this);
 * - native/Android: the Capacitor app has no same-origin proxy, so it uses the
 *   public engine directly (`PROD_P2P_URL`), exactly as the L0/L1 endpoints do.
 *   `EXPO_PUBLIC_P2P_ENGINE_URL` (e.g. webapp.sh --with-p2p) still overrides it.
 */
export const P2P_ENGINE_URL = p2pEngineUrl({
  env: process.env.EXPO_PUBLIC_P2P_ENGINE_URL,
  isDev: IS_DEV,
  isWebBrowser: IS_WEB_BROWSER,
  prodUrl: PROD_P2P_URL,
});

/**
 * L1-SOCIAL base URL for seller-anchored `social.p2p-order` records
 * (docs/p2p.md §11). Dev points at the local social node (e2e/l1social.sh);
 * production has no social node yet, so the P2P screen keeps the legacy
 * engine-intake path until EXPO_PUBLIC_P2P_SOCIAL_URL is baked.
 */
export const P2P_SOCIAL_URL =
  process.env.EXPO_PUBLIC_P2P_SOCIAL_URL || (IS_DEV ? 'http://127.0.0.1:24091/' : '');

/**
 * Read the P2P order book straight from L1-SOCIAL instead of the engine's
 * `/public/orders` (docs/p2p.md §26 — the first step of engine independence).
 * Off by default so existing engine-backed flows are unchanged; needs
 * `P2P_SOCIAL_URL` and falls back to the engine on any error. Set
 * `EXPO_PUBLIC_P2P_CHAIN_BOOK=1` to opt in. The chain book carries no
 * seller reputation (that lives in the engine's swap log).
 */
export const P2P_CHAIN_BOOK = process.env.EXPO_PUBLIC_P2P_CHAIN_BOOK === '1';

/**
 * Trusted engine escrow pubkeys (prefixed ML-DSA pubkey hex, comma-separated,
 * `EXPO_PUBLIC_P2P_ENGINE_PUBKEYS`). A counterparty-supplied `enginePubkey` is
 * accepted **only** if it is one of these (or, when the list is empty, matches
 * the engine the wallet is configured with). This is the buyer-side defence
 * against a seller pinning its own key and rugging the fiat leg (docs/p2p.md
 * §27.4 #1). Set it to every engine an operator runs.
 */
export const P2P_ENGINE_PUBKEYS: string[] = (process.env.EXPO_PUBLIC_P2P_ENGINE_PUBKEYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
