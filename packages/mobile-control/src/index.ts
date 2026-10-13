/**
 * mobile-control — general device control over a user-paired mobile-mcp
 * endpoint (docs/p2p.md §12). This entry is environment-neutral (RN/web safe):
 * the Streamable-HTTP client, the curated tool surface and the parsers. The
 * stdio transport and the Ed25519 DID signer live in `mobile-control/node`.
 */
export * from "./client.js";
export * from "./android-client.js";
