/**
 * Resolve the P2P settlement-engine base URL (services/p2p-engine) for a build.
 *
 * The engine is a host-side service, so where it lives depends on how the app
 * is delivered:
 *
 * - `EXPO_PUBLIC_P2P_ENGINE_URL`, when baked at build time, always wins
 *   (`deploy/tag.sh` bakes the web build's same-origin `/p2p`;
 *   `webapp.sh --with-p2p` bakes a local engine URL);
 * - dev builds default to the engine's local port;
 * - a plain browser production build has no same-origin proxy from an unknown
 *   host, so it stays empty and the P2P screen shows "not configured";
 * - native/Android is a Capacitor wrap of the static export (`IS_DEV` and
 *   `IS_WEB_BROWSER` both false) with no `/p2p` proxy of its own, so it uses
 *   the public engine directly, like the L0/L1 endpoints.
 *
 * Kept pure (no react-native `Platform`/Capacitor import) so it is unit
 * testable; `constants/app.ts` supplies the platform flags.
 */
export function p2pEngineUrl(opts: {
  env: string | undefined;
  isDev: boolean;
  isWebBrowser: boolean;
  prodUrl: string;
}): string {
  const { env, isDev, isWebBrowser, prodUrl } = opts;
  if (env) return env;
  if (isDev) return 'http://127.0.0.1:8108';
  return isWebBrowser ? '' : prodUrl;
}
