/**
 * DID-authenticated requests to a paired mobile-mcp endpoint (docs/p2p.md §12).
 *
 * The implementation lives in the shared **`mobile-control`** package
 * (`mobile-control/node`) so the wallet, the p2p engine and the worker all sign
 * identically. Re-exported here to keep the worker's public surface stable.
 *
 *   Authorization: DID did="did:key:z…", ts="<ms>", sig="<hex>"
 *   base = `mcp-auth:${ts}:${sha256hex(canonicalJson(body))}`
 */
export {
  canonicalJson,
  sha256Hex,
  authBase,
  ed25519Signer,
  didAuthHeaders,
  signerAuthHeaders,
  type RequestSigner,
} from "mobile-control/node";
