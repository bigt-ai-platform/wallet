/**
 * Prediction-chain URL resolution.
 *
 * The prediction chain (l1-prediction-server) is its own L1 node, separate from
 * the L1-ORDER node. Stored chain configs — and every build before the split —
 * pointed the `prediction` chain at the ORDER base (`/l1/`, `ordereuN`, the
 * private relay or the legacy JSF host). Asking the order node for
 * `searchContractTokens` returns an empty list, and a missing chain entry makes
 * the lookup fail outright, so the Predict page reported
 * "Prediction markets are unavailable".
 *
 * `resolvePredictionUrl` keeps a genuinely custom URL (a self-hosted prediction
 * node) and only migrates a known order base onto the prediction default.
 */

/** Hosts/base paths that serve the L1-ORDER chain, never the prediction chain. */
function isOrderChainBase(url: string): boolean {
  const raw = (url ?? '').trim().replace(/\/+$/, '');
  if (!raw) return false;
  const lower = raw.toLowerCase();
  // Same-origin proxy paths of the deployed web build: /l1/ is the order
  // proxy (the prediction proxy is /l1p/, which must be kept).
  if (lower.startsWith('/')) return lower === '/l1';
  const noScheme = lower.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const [hostPort, ...rest] = noScheme.split('/');
  const host = hostPort.split(':')[0];
  const path = `/${rest.join('/')}`.replace(/\/+$/, '');
  // The private relay (../apiserver) serves ORDER at /l1/.
  if (host === '92.5.34.128') return path === '/l1';
  // Order-chain node hosts.
  if (/^order(eu|hk)\d*\.bigtangle\.org$/.test(host)) return true;
  // Legacy JSF host: serves the webapp, not the JSON-RPC order API.
  if (host === 'm.bigtangle.org') return true;
  return false;
}

/**
 * The prediction chain URL to use: `stored` when it is a real prediction node,
 * otherwise (missing, or an order-chain base) the platform default.
 */
export function resolvePredictionUrl(
  stored: string | undefined,
  predictionUrl: string,
): string {
  const raw = (stored ?? '').trim();
  if (!raw) return predictionUrl;
  return isOrderChainBase(raw) ? predictionUrl : raw;
}

/** Exported for the unit test: true when `url` addresses the L1-order chain. */
export function pointsAtOrderChain(url: string): boolean {
  return isOrderChainBase(url);
}
