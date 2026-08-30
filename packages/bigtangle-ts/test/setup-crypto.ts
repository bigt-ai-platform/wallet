import { webcrypto } from "node:crypto";

// Node 18 does not expose a global WebCrypto object (added in Node 19), but
// PQKey.createNew()/sign() and @noble/post-quantum rely on
// crypto.getRandomValues. Expose Node's webcrypto so the integration tests can
// generate/sign PQ keys regardless of the runtime Node version.
if (typeof globalThis.crypto === "undefined") {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
