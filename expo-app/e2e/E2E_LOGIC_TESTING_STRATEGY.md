# E2E + Logic Testing Strategy

## Problem: Current Tests Are Shallow

Current Detox E2E tests only verify **UI interactions**:
- ✅ Button clicks work
- ✅ Screens navigate correctly
- ✅ Elements are visible
- ❌ **Business logic is NOT verified**

Example:
```typescript
// Current: Shallow UI test
it('should create wallet', async () => {
  await tapByTestId('create-wallet-button');
  await detoxExpect(element(by.id('wallet-screen'))).toBeVisible();
  // Missing: Is the wallet actually valid? Are keys correct?
});
```

## Solution: Hybrid E2E + Logic Tests

Combine UI automation with logic verification:

```typescript
// Enhanced: UI + Logic test
it('should create valid wallet', async () => {
  // UI: Create wallet through app
  await tapByTestId('create-wallet-button');
  await typeTextByTestId('password-input', 'Test123!');
  await tapByTestId('create-confirm-button');

  // LOGIC: Verify wallet is actually valid
  const walletData = await getWalletFromStorage();
  expect(walletData).toBeDefined();
  expect(walletData.keys.length).toBeGreaterThan(0);

  const address = await deriveAddressFromKeys(walletData.keys[0]);
  expect(address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/); // Valid Bitcoin address

  // LOGIC: Verify cryptographic validity
  const isValid = await verifyKeyPair(walletData.keys[0]);
  expect(isValid).toBe(true);

  // UI: Verify displayed address matches computed address
  const displayedAddress = await getTextById('wallet-address');
  expect(displayedAddress).toBe(address);
});
```

## Architecture

### Current: Detox Only (UI Layer)
```
┌─────────────────────┐
│   Detox E2E Tests   │ ← UI interactions only
└─────────┬───────────┘
          │
┌─────────▼───────────┐
│   React Native UI   │
└─────────┬───────────┘
          │
┌─────────▼───────────┐
│   Business Logic    │ ← Not tested!
└─────────────────────┘
```

### Enhanced: Detox + Logic Verification
```
┌─────────────────────────────────────┐
│   Hybrid E2E + Logic Tests          │
│   - UI automation (Detox)           │
│   - Logic verification (direct API) │
└─────────┬───────────────────────────┘
          │
┌─────────▼───────────┬─────────────┐
│   React Native UI   │ bigtangle-ts│
└─────────┬───────────┴─────────────┘
          │
┌─────────▼───────────────────────────┐
│   Business Logic (Verified!)        │
└─────────────────────────────────────┘
```

## Implementation Strategy

### 1. Create Logic Verification Helpers

`e2e/helpers/logic-verification.ts`:
```typescript
import { ECKey, Address, Wallet } from '@bigtangle/bigtangle-ts';
import * as SecureStore from 'expo-secure-store';

/**
 * Verify wallet cryptographic validity
 */
export async function verifyWalletLogic() {
  // Get wallet from app storage
  const walletJson = await SecureStore.getItemAsync('wallet');
  if (!walletJson) throw new Error('No wallet found');

  const wallet = JSON.parse(walletJson);

  // Verify keys are valid
  const key = ECKey.fromPrivateString(wallet.privateKey);
  const address = key.toAddress(networkParameters);

  return {
    isValid: true,
    address: address.toString(),
    publicKey: key.getPublicKeyAsHex(),
  };
}

/**
 * Verify transaction was properly signed
 */
export async function verifyTransaction(txHash: string) {
  const wallet = await getWalletFromApp();
  const tx = await wallet.getTransaction(txHash);

  // Verify signature
  const isValidSignature = tx.verifySignature();

  // Verify amounts
  const inputSum = tx.inputs.reduce((sum, input) => sum + input.value, 0n);
  const outputSum = tx.outputs.reduce((sum, output) => sum + output.value, 0n);

  return {
    isValidSignature,
    inputSum,
    outputSum,
    fee: inputSum - outputSum,
  };
}

/**
 * Verify balance calculation
 */
export async function verifyBalanceCalculation(displayedBalance: string) {
  const wallet = await getWalletFromApp();
  const utxos = await wallet.getUTXOs();

  const calculatedBalance = utxos.reduce((sum, utxo) => {
    return sum + BigInt(utxo.value);
  }, 0n);

  return {
    displayed: displayedBalance,
    calculated: calculatedBalance.toString(),
    matches: displayedBalance === calculatedBalance.toString(),
  };
}
```

### 2. Enhanced Test Examples

#### Wallet Creation Test
`e2e/tests/02-wallet-enhanced.test.ts`:
```typescript
import { verifyWalletLogic } from '../helpers/logic-verification';

describe('Wallet Creation (UI + Logic)', () => {
  it('should create cryptographically valid wallet', async () => {
    // UI: Create wallet
    await tapByTestId('create-wallet-button');
    await typeTextByTestId('password-input', 'Test123!');
    await tapByTestId('create-button');

    // Wait for wallet creation
    await waitForElementToBeVisible(by.id('wallet-address'));

    // LOGIC: Verify wallet validity
    const verification = await verifyWalletLogic();
    expect(verification.isValid).toBe(true);

    // LOGIC: Verify address format
    expect(verification.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);

    // UI+LOGIC: Verify displayed address matches computed
    const displayedAddress = await getTextById('wallet-address');
    expect(displayedAddress).toBe(verification.address);

    await takeScreenshot('wallet-created-verified');
  });

  it('should derive correct address from imported key', async () => {
    const testKey = 'ec1d240521f7f254c52aea69fca3f28d754d1b89f310f42b0fb094d16814317f';
    const expectedAddress = '...' // Pre-computed

    // UI: Import wallet
    await tapByTestId('import-wallet-button');
    await typeTextByTestId('private-key-input', testKey);
    await tapByTestId('import-button');

    // LOGIC: Verify correct address derivation
    const key = ECKey.fromPrivateString(testKey);
    const derivedAddress = key.toAddress(networkParameters).toString();
    expect(derivedAddress).toBe(expectedAddress);

    // UI+LOGIC: Verify UI shows correct address
    const displayedAddress = await getTextById('wallet-address');
    expect(displayedAddress).toBe(derivedAddress);
  });
});
```

#### Transaction Test
`e2e/tests/03-transaction-enhanced.test.ts`:
```typescript
import { verifyTransaction } from '../helpers/logic-verification';

describe('Transaction (UI + Logic)', () => {
  it('should create properly signed transaction', async () => {
    // Setup: Create and fund wallet
    await createAndFundWallet('1000000');

    // UI: Create transaction
    await tapByTestId('send-tab');
    await typeTextByTestId('recipient-input', recipientAddress);
    await typeTextByTestId('amount-input', '0.001');
    await tapByTestId('send-button');
    await tapByTestId('confirm-button');

    // Wait for transaction
    await waitForElementToBeVisible(by.text('Transaction sent'));

    // Get transaction hash from UI
    const txHash = await getTextById('transaction-hash');

    // LOGIC: Verify transaction validity
    const verification = await verifyTransaction(txHash);
    expect(verification.isValidSignature).toBe(true);

    // LOGIC: Verify fee calculation
    const expectedFee = 1000n; // Fee in satoshis
    expect(verification.fee).toBeGreaterThanOrEqual(expectedFee);

    // LOGIC: Verify amounts
    expect(verification.outputSum).toBe(100000n); // 0.001 BTC
    expect(verification.inputSum).toBeGreaterThan(verification.outputSum);
  });

  it('should correctly calculate and display balance after send', async () => {
    const initialBalance = '1.0';
    const sendAmount = '0.1';

    // Setup
    await createAndFundWallet(initialBalance);
    const initialDisplayed = await getTextById('balance-display');

    // UI: Send transaction
    await sendTransaction(recipientAddress, sendAmount);

    // Wait for balance update
    await waitFor(element(by.id('balance-display')))
      .not.toHaveText(initialDisplayed)
      .withTimeout(10000);

    // LOGIC: Verify balance calculation
    const newDisplayed = await getTextById('balance-display');
    const verification = await verifyBalanceCalculation(newDisplayed);

    expect(verification.matches).toBe(true);

    // LOGIC: Verify balance decreased by correct amount
    const initialBigInt = BigInt(initialBalance.replace('.', ''));
    const sendBigInt = BigInt(sendAmount.replace('.', ''));
    const calculatedBigInt = BigInt(verification.calculated);

    expect(calculatedBigInt).toBeLessThan(initialBigInt - sendBigInt);
  });
});
```

#### Token Search Logic Test
`e2e/tests/06-tokens-enhanced.test.ts`:
```typescript
describe('Tokens (UI + Logic)', () => {
  it('should correctly filter tokens by search', async () => {
    await navigateToTabByName('Tokens');
    await waitForNetwork(2000);

    // LOGIC: Get all tokens from API
    const allTokens = await fetchAllTokensFromAPI();
    expect(allTokens.length).toBeGreaterThan(0);

    // UI: Search for specific token
    const searchTerm = 'BIG';
    await typeTextByTestId('tokens-search-input', searchTerm);
    await waitForNetwork(500);

    // LOGIC: Calculate expected filtered results
    const expectedTokens = allTokens.filter(token =>
      token.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      token.id.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // UI+LOGIC: Verify displayed tokens match filter logic
    const displayedCount = await getElementCount(by.id(/token-card-\d+/));
    expect(displayedCount).toBe(expectedTokens.length);

    // LOGIC: Verify each displayed token matches filter
    for (let i = 0; i < displayedCount; i++) {
      const tokenName = await getTextById(`token-card-${i}`);
      const matchesFilter = expectedTokens.some(t =>
        tokenName.includes(t.name) || tokenName.includes(t.id)
      );
      expect(matchesFilter).toBe(true);
    }
  });
});
```

## Do We Need Playwright?

### Detox vs Playwright

| Feature | Detox | Playwright |
|---------|-------|------------|
| **Target** | React Native (iOS/Android) | Web browsers |
| **Use Case** | Mobile app testing | Web app testing |
| **Required?** | ✅ Yes (for mobile) | ⚠️ Only if testing web version |

### Decision Matrix

**Use Detox** (Current - Correct choice):
- ✅ Testing iOS app
- ✅ Testing Android app
- ✅ React Native components
- ✅ Native mobile features (gestures, permissions)

**Add Playwright** (Optional):
```typescript
// Only if you want to test web version
// e2e-web/tests/wallet.spec.ts
import { test, expect } from '@playwright/test';

test('web wallet creation', async ({ page }) => {
  await page.goto('http://localhost:8081');
  await page.click('[data-testid="create-wallet"]');

  // Can also add logic verification
  const walletData = await page.evaluate(() => {
    return window.localStorage.getItem('wallet');
  });

  expect(walletData).toBeTruthy();
});
```

**Recommendation**:
- ✅ **Keep Detox** for mobile (iOS/Android)
- ⚠️ **Add Playwright** only if:
  - You need to test the web version (Expo web)
  - You have web-specific features
  - You want cross-browser testing

For this project, **Detox alone is sufficient** since it's primarily a mobile app.

## Implementation Plan

### Phase 1: Add Logic Verification Helpers
```bash
e2e/helpers/
├── setup.ts              # Existing UI helpers
├── wallet.ts             # Existing wallet helpers
└── logic-verification.ts # NEW: Logic verification helpers
```

### Phase 2: Enhance Existing Tests
Add logic checks to existing tests:
- `02-wallet.test.ts` → Add key validation, address verification
- `03-transaction.test.ts` → Add signature verification, balance checks
- `04-market.test.ts` → Add price calculation verification
- `06-tokens.test.ts` → Add search algorithm verification

### Phase 3: Add Dedicated Logic Tests
Create new test files for complex logic:
```bash
e2e/tests/
├── 08-wallet-logic.test.ts       # Deep wallet logic tests
├── 09-transaction-logic.test.ts  # Transaction validation tests
├── 10-crypto-logic.test.ts       # Cryptographic operations tests
```

### Phase 4: Integration with CI/CD
```yaml
# .github/workflows/e2e-tests.yml
name: E2E + Logic Tests
on: [push, pull_request]

jobs:
  test:
    steps:
      - name: Run UI Tests
        run: detox test --configuration ios.sim.debug

      - name: Run Logic Verification
        run: npm run test:logic

      - name: Generate Coverage Report
        run: npm run coverage:merge
```

## Benefits

### Before (UI Only)
- ✅ Tests UI works
- ❌ Doesn't catch logic bugs
- ❌ Can't verify correctness
- ❌ False confidence

### After (UI + Logic)
- ✅ Tests UI works
- ✅ **Verifies business logic is correct**
- ✅ **Catches cryptographic errors**
- ✅ **Validates calculations**
- ✅ **Ensures data integrity**
- ✅ True confidence in app quality

## Example: Real Bug Caught

**UI-only test** ❌ Would PASS:
```typescript
it('displays balance', async () => {
  await detoxExpect(element(by.id('balance'))).toBeVisible();
  // Bug: Balance shows "1.00" but actual balance is "0.10"
  // Test passes! UI is visible.
});
```

**UI+Logic test** ✅ Would CATCH:
```typescript
it('displays correct balance', async () => {
  await detoxExpect(element(by.id('balance'))).toBeVisible();

  const displayed = await getTextById('balance');
  const actual = await verifyBalanceCalculation(displayed);

  expect(actual.matches).toBe(true);
  // Bug caught! Displayed: "1.00", Actual: "0.10"
  // Test fails correctly.
});
```

## Conclusion

**Current State**: Detox E2E tests are good for UI but missing logic verification.

**Recommendation**:
1. ✅ **Keep Detox** - It's the right choice for React Native
2. ✅ **Add logic verification helpers** - Verify business logic correctness
3. ✅ **Enhance existing tests** - Add logic checks to UI tests
4. ❌ **Don't add Playwright** (unless testing web version)

This gives you **comprehensive testing** without adding unnecessary tools.
