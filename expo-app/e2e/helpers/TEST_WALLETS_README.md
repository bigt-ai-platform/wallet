# Test Wallet Seeds for E2E Testing

This directory contains test wallet seeds and initialization utilities for E2E testing.

## ⚠️ **IMPORTANT: TEST DATA ONLY**

**NEVER use these wallets, keys, or passwords in production!** These are public test credentials for automated testing only.

## Files

### `test-wallet-seed.ts`

Defines pre-configured test wallets with known private keys, passwords, and addresses.

**Available Test Wallets:**

- `YUAN_ISSUER` - Token issuer wallet for creating test tokens
- `USER_1` - Primary test user wallet
- `USER_2` - Secondary test user wallet
- `SIMPLE_TEST` - Simple test wallet with predictable key

### `test-wallet-init.ts`

Helper functions to initialize test wallets in the app storage for E2E testing.

## Usage

### In API Tests (api.test.ts)

```typescript
import {
  TEST_WALLETS,
  getAllUserKeys,
  getYuanIssuerKey,
} from "../helpers/test-wallet-seed";

// Get predefined test keys
const userKeys = getAllUserKeys(); // [USER_1, USER_2]
const issuerKey = getYuanIssuerKey(); // YUAN_ISSUER

// Access wallet config
const wallet = TEST_WALLETS.USER_1;
console.log(wallet.address); // Wallet address
console.log(wallet.privateKey); // Private key
console.log(wallet.password); // Password for encryption
```

### In E2E/Detox Tests

```typescript
import {
  setupTestWalletEnvironment,
  getTestWalletCredentials,
} from "../helpers/test-wallet-init";

// Setup test environment
const walletConfig = await setupTestWalletEnvironment("USER_1");

// Get credentials for UI automation
const { password, label } = getTestWalletCredentials("USER_1");

// Use in test
await typeTextByTestId("password-input", password);
```

### Initializing Wallets in App Storage

```typescript
import { initializeTestWalletInApp } from "../helpers/test-wallet-init";
import { useWallet } from "@/state/wallet";

const { storeEncryptedWallet } = useWallet();

// Initialize a test wallet
const result = await initializeTestWalletInApp(
  TEST_WALLETS.USER_1,
  storeEncryptedWallet,
);

console.log(`Wallet initialized at: ${result.address}`);
```

## Test Wallet Details

### Yuan Issuer

- **Purpose:** Token creation and issuance
- **Private Key:** `8db6bd17fa4a827619e165bfd4b0f551705ef2d549a799e7f07115e5c3abad55`
- **Password:** `TestYuanIssuer123!`

### User 1

- **Purpose:** Primary test user for transactions
- **Private Key:** `9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891`
- **Password:** `TestUser1Pass123!`

### User 2

- **Purpose:** Secondary test user for P2P transactions
- **Private Key:** `88c8383183d9db0a5fdbd8d862709f729e055d8981b8515044f28d4cf12d3f27`
- **Password:** `TestUser2Pass123!`

### Simple Test

- **Purpose:** Basic testing with predictable key
- **Private Key:** `0000000000000000000000000000000000000000000000000000000000000001`
- **Address:** `1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm`
- **Password:** `TestPassword123!`

## Test Scenarios

Pre-configured scenarios for common test cases:

```typescript
import { TEST_SCENARIOS } from "../helpers/test-wallet-seed";

// User payment scenario
const { sender, receiver, amount } = TEST_SCENARIOS.USER_PAYMENT;

// Token creation scenario
const { issuer, tokenName, totalSupply } = TEST_SCENARIOS.TOKEN_CREATION;

// Token transfer scenario
const { sender, receiver, tokenAmount } = TEST_SCENARIOS.TOKEN_TRANSFER;
```

## Configuration

Default test configuration values:

```typescript
import { DEFAULT_TEST_CONFIG } from "../helpers/test-wallet-seed";

const {
  networkTimeout, // 30000ms
  blockConfirmationWait, // 5000ms
  balanceCheckInterval, // 2000ms
  maxBalanceWaitTime, // 30000ms
} = DEFAULT_TEST_CONFIG;
```

## Debugging

Export wallet information for manual testing:

```typescript
import { exportTestWalletInfo } from "../helpers/test-wallet-init";

// Print all wallet details to console
exportTestWalletInfo("USER_1");
```

Output:

```
============================================================
Test Wallet: Test User 1
============================================================
Address:     n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs
Public Key:  02...
Private Key: 9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891
Password:    TestUser1Pass123!
============================================================
⚠️  WARNING: This is test data only - NEVER use in production!
============================================================
```

## Best Practices

1. **Never use test credentials in production**
2. **Keep test wallets consistent** - Use the predefined seeds instead of generating random keys
3. **Document test scenarios** - Add new scenarios to `TEST_SCENARIOS` for reusability
4. **Clean up after tests** - Reset wallet state between test runs
5. **Use meaningful labels** - Name your test wallets clearly

## Integration with CI/CD

These test wallets are designed to work in CI/CD environments:

```yaml
# Example GitHub Actions usage
- name: Run E2E Tests
  run: |
    yarn e2e:test
  env:
    TEST_WALLET_USER_1_KEY: ${{ secrets.TEST_WALLET_USER_1_KEY }}
```

Note: Even in CI/CD, these should remain test-only credentials.
