/** App-wide constants shared across screens. */
export const APP_VERSION = '1.2.0';

/** True in development builds (Metro/Expo), false in production exports. */
export const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * Local dev-server endpoints (dev.sh: L0 :24089, L1 :24086). Development
 * builds default here; production discovers L0 from the network seeds and
 * uses the configured L1 order-match endpoints.
 */
export const DEV_L0_URL = 'http://127.0.0.1:24089/';
export const DEV_L1_URL = 'http://127.0.0.1:24086/';

/** Default L1 (order match) chains per network. */
export const DEFAULT_L1_CHAINS_MAINNET = [
  { name: IS_DEV ? 'Local' : 'Main', url: IS_DEV ? DEV_L1_URL : 'https://m.bigtangle.org' },
];
export const DEFAULT_L1_CHAINS_TESTNET = [
  { name: IS_DEV ? 'Local' : 'Test', url: IS_DEV ? DEV_L1_URL : 'https://testm.bigtangle.org' },
];
