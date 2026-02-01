# Bigtangle Integration

The bapp project now includes `@bigtangle/bigtangle-ts` as a local dependency for blockchain functionality.

## Installation

The bigtangle-ts library has been added as a local file dependency:
```json
"@bigtangle/bigtangle-ts": "file:../../bigtangle-ts"
```

## Usage

### Basic Import

```typescript
import * as Bigtangle from '@bigtangle/bigtangle-ts';
```

### Using the Utility Helper

A utility file has been created at `expo-app/sources/utils/bigtangle.ts` for convenient access:

```typescript
import { initBigtangle, getBigtangleVersion } from '@/utils/bigtangle';

// Initialize bigtangle
const bigtangle = await initBigtangle();

// Use helper functions
const version = getBigtangleVersion();
```

### Example in a Component

```typescript
import * as React from 'react';
import { View, Text } from 'react-native';
import { initBigtangle } from '@/utils/bigtangle';

export default function BigtangleScreen() {
    const [status, setStatus] = React.useState('Not initialized');

    React.useEffect(() => {
        (async () => {
            try {
                await initBigtangle();
                setStatus('Initialized successfully');
            } catch (error) {
                setStatus(`Error: ${error.message}`);
            }
        })();
    }, []);

    return (
        <View>
            <Text>Bigtangle Status: {status}</Text>
        </View>
    );
}
```

## Bigtangle-TS Features

The library provides:
- Blockchain protocol implementation
- Cryptographic utilities
- Transaction handling
- Wallet management
- Network communication

See the bigtangle-ts source code at `../bigtangle-ts` for complete API documentation.

## Building bigtangle-ts

If you need to rebuild the bigtangle-ts library:

```bash
cd ../bigtangle-ts
yarn install
yarn build
```

The built files in `../bigtangle-ts/dist/` will be automatically used by the bapp project.

## Type Definitions

TypeScript definitions are included with the library. The types are exported from:
```
../bigtangle-ts/dist/index.d.ts
```

## Dependencies

The bigtangle-ts library brings these additional dependencies:
- `@noble/ciphers` - Cryptographic ciphers
- `@noble/hashes` - Hash functions
- `axios` - HTTP client
- `bs58` - Base58 encoding
- `secp256k1` - Elliptic curve cryptography
- `socket.io-client` - WebSocket communication
- And more...

These are automatically installed when you run `yarn install`.

## Troubleshooting

### Module Resolution Issues

If you encounter module resolution errors, try:
```bash
yarn install --force
cd expo-app && yarn typecheck
```

### Build Issues

If bigtangle-ts needs to be rebuilt:
```bash
cd ../bigtangle-ts
rm -rf dist
yarn build
cd ../bapp
yarn install
```

### React Native Compatibility

Some Node.js modules used by bigtangle-ts may need shims for React Native. Common issues:
- `crypto` - Use `expo-crypto` or `react-native-crypto`
- `stream` - Use `readable-stream`
- `buffer` - Use `buffer` npm package

Add shims in `metro.config.js` if needed.

## Next Steps

1. Review the bigtangle-ts API in `../bigtangle-ts/`
2. Implement your blockchain features in `expo-app/sources/utils/bigtangle.ts`
3. Create screens and components that use bigtangle functionality
4. Add error handling and loading states
5. Test on all platforms (iOS, Android, Web)
