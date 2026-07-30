# bigt-app

A TypeScript library for building decentralized social networking applications, compatible with Node.js, React Native, and web browsers.

## Features

- Full TypeScript support
- React Native and web browser compatible
- Social networking features including profiles, posts, messaging, and connections
- Decentralized identity and privacy controls
- Peer-to-peer communication capabilities

## Installation

```bash
npm install @bigtangle/bigtangle-ts
```

## Usage

```typescript
import { PQKey, Transaction } from '@bigtangle/bigtangle-ts';

// Create a new private key
const key = PQKey.createNew();

// Create and sign transactions
// See documentation for more examples
```

## Compatibility

This library is compatible with:
- Node.js
- React Native
- Modern web browsers
- Any environment with Web Crypto API support

## Differences from Java Implementation

This TS library mirrors the Java `bigtangle-core` implementation but has several important differences that must be maintained for compatibility:

### Key Format: Prefixed vs Unprefixed

In Java, `PQKey.getPublicKeyBytes()` / `getPubKey()` returns **prefixed** bytes (`0x05 || keyBundle.serialize()`).
In TypeScript, the same methods return **unprefixed** keyBundle bytes (starting with `BUNDLE_VERSION = 0x01`).

| Method | Java | TypeScript |
|--------|------|------------|
| `getPubKey()` | prefixed (`0x05 + serialize()`) | unprefixed (`keyBundle.serialize()`) |
| `getPublicKeyBytes()` | prefixed (`0x05 + serialize()`) | unprefixed (`keyBundle.serialize()`) |
| `getPrefixedPublicKeyBytes()` | N/A (use `getPubKey()`) | prefixed (`0x05 + serialize()`) |
| `getKeyBundleBytes()` | unprefixed (`keyBundle.serialize()`) | N/A (use `getPubKey()`) |
| `getPublicKeyAsHex()` | hex of PREFIXED bytes | hex of UNPREFIXED bytes |

**Always use `getPrefixedPublicKeyBytes()` when sending data to the Java server** (e.g., in `MultiSignAddress`, `fundAddresses`, `OrderOpenInfo`, `multiSignBy`). Use `getPubKey()` only for internal key material operations.

### Jackson-JS Parser Limitations

The `jackson-js` library used for JSON serialization/deserialization fails to parse responses containing very long hex strings (5000+ characters, such as PQ public key hex). The error manifests as `[22:10]: Unexpected token: '{'`.

**Workaround**: Use native `JSON.parse(resp)` instead of `Json.jsonmapper().parse(resp, { mainCreator: ... })` for server responses that may contain long hex strings. This affects `checkTokenId()` and test utilities like `pollToken()`.

### Transaction Version Upgrade

Java's `LocalTransactionSigner.signInputs()` upgrades `tx.version` to `PQConstants.TX_PQ_VERSION` (2) before computing the signature hash. The TS implementation must do the same:

```typescript
if (tx.version < PQConstants.TX_PQ_VERSION) {
    tx.version = PQConstants.TX_PQ_VERSION;
}
```

Without this upgrade, the `hashForSignature()` and `bitcoinSerialize()` methods take different code paths (version >= 2 includes PQ key bundle and signature bundle data), producing signatures that the Java server rejects with `ScriptException: OP_EQUALVERIFY: non-equal data`.

### Server API Differences

- `toBase58()` on `PQAddress`: In Java, `toBase58()` simply returns `toHex()`. In TypeScript, `toBase58()` does not exist on `PQAddress` — use `toHex()` instead.
- `getTokenById` response: Returns long hex strings that can cause `jackson-js` to fail. Use native `JSON.parse`.

### Wallet Key Setup

Java's `RemoteTest.setUp()` creates the genesis wallet key from seeds `(0x01, 0x02)` via `PQKey.fromSeeds(mlDsaSeed, slhDsaSeed)`. The TS equivalent should match:

```typescript
const mlDsaSeed = new Uint8Array(32).fill(0x01);
const slhDsaSeed = new Uint8Array(32).fill(0x02);
wallet = Wallet.fromKeysURL(params, [PQKey.fromSeeds(mlDsaSeed, slhDsaSeed)], url);
```

Using hex-derived keys (`createKeyFromHex`) produces different key material than Java's seed-based approach.

## Development

```bash
# Install dependencies
npm install

# Build the project (required after editing source .ts files)
npm run build

# Run tests
npm test

# Run integration tests (requires Java backend)
TEST_CONTEXT_ROOT=http://localhost:8089/ TEST_L1_URL=http://localhost:8086/ \
  INCLUDE_INTEGRATION_TESTS=1 npm run test:integration

# Lint the code
npm run lint
```

**Important**: The `dist/` directory contains compiled JavaScript. After editing `src/` files, run `npm run build` to keep it in sync. Stale `dist/` output can cause subtle bugs (e.g., `getPubKeyHash()` returning unprefixed hash when source says prefixed).

## License

MIT