# Quick Start: E2E Tests with Logic Verification

## TL;DR

E2E tests now verify **both UI and business logic**. Use the helpers from `helpers/logic-verification.ts` to add logic checks to your tests.

## Quick Example

```typescript
// Before: UI only ❌
it('should create wallet', async () => {
  await createNewWallet();
  await detoxExpect(element(by.id('wallet-screen'))).toBeVisible();
  // Test passes even if wallet is cryptographically invalid!
});

// After: UI + Logic ✅
import { verifyWalletCryptography } from '../helpers/logic-verification';

it('should create wallet', async () => {
  // UI verification
  await createNewWallet();
  await detoxExpect(element(by.id('wallet-screen'))).toBeVisible();

  // Logic verification
  const verification = await verifyWalletCryptography();
  expect(verification.isValid).toBe(true);
  expect(verification.publicKey!.length).toBe(66);
  // Test fails if wallet is invalid!
});
```

## Available Verification Helpers

Import from `../helpers/logic-verification`:

### Wallet & Crypto
```typescript
// Verify wallet is cryptographically valid
const result = await verifyWalletCryptography();
expect(result.isValid).toBe(true);
expect(result.address).toBeDefined();
expect(result.publicKey).toBeDefined();

// Verify Bitcoin address format
const isValid = verifyAddressFormat('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
expect(isValid).toBe(true);

// Verify key pair
const keyResult = await verifyKeyPair(privateKeyHex);
expect(keyResult.isValid).toBe(true);
expect(keyResult.address).toBeDefined();

// Get wallet from storage
const wallet = await getWalletFromStorage();
expect(wallet).toBeDefined();
expect(wallet.privateKey).toBeDefined();
```

### Password
```typescript
// Verify password strength
const strength = verifyPasswordStrength('MyStr0ng!Pass');
expect(strength.isValid).toBe(true);
expect(strength.score).toBeGreaterThanOrEqual(4);
console.log(`Feedback: ${strength.feedback.join(', ')}`);
```

### Amounts & Transactions
```typescript
// Verify amount format and parsing
const result = verifyAmountFormat('0.001');
expect(result.isValid).toBe(true);
expect(result.parsedAmount).toBe(BigInt(100000)); // satoshis

// Calculate transaction fee
const fee = calculateTransactionFee(1, 2); // 1 input, 2 outputs
expect(fee).toBeGreaterThan(0);
console.log(`Estimated fee: ${fee} satoshis`);
```

### Market & Prices
```typescript
// Verify price change calculation
const result = verifyPriceChange(100, 90);
expect(result.change).toBe(10);
expect(result.changePercent).toBeCloseTo(11.11, 0.1);
expect(result.direction).toBe('up');
```

### Search & Filtering
```typescript
// Verify token filter logic
const tokens = [
  { tokenname: 'BigTangle', tokenid: 'BIG123', description: 'Main' },
  { tokenname: 'Bitcoin', tokenid: 'BTC456', description: 'BTC' },
];
const filtered = verifyTokenFilter(tokens, 'BIG');
expect(filtered.length).toBe(2); // BigTangle + Bitcoin
```

### Sorting
```typescript
// Verify sort order
const items = [{ price: 1 }, { price: 2 }, { price: 3 }];
const isAscending = verifySortOrder(items, 'price', true);
expect(isAscending).toBe(true);
```

## Test Structure Template

```typescript
import { verifyWalletCryptography, verifyAddressFormat } from '../helpers/logic-verification';

describe('My Feature', () => {
  it('should do something', async () => {
    // ============ UI VERIFICATION ============
    // Test the UI works
    await tapByTestId('my-button');
    await detoxExpect(element(by.id('result'))).toBeVisible();

    // ============ LOGIC VERIFICATION ============
    // Test the logic is correct
    const verification = await verifyWalletCryptography();
    expect(verification.isValid).toBe(true);

    // ============ UI + LOGIC CONSISTENCY ============
    // Test UI matches logic
    const displayedValue = await element(by.id('value')).getText();
    expect(displayedValue).toBe(verification.address);

    console.log('✅ Test verified:', verification.address);
  });
});
```

## Common Patterns

### Pattern 1: Validate Input
```typescript
it('should validate input', async () => {
  // Logic check first
  const isValid = verifyAddressFormat('invalid');
  expect(isValid).toBe(false);

  // UI should reject it
  await typeTextByTestId('address-input', 'invalid');
  await tapByTestId('submit');
  await detoxExpect(element(by.text('Invalid address'))).toBeVisible();
});
```

### Pattern 2: Verify Calculation
```typescript
it('should calculate correctly', async () => {
  const amount = '0.001';

  // Verify calculation
  const result = verifyAmountFormat(amount);
  expect(result.parsedAmount).toBe(BigInt(100000));

  // UI should show correct result
  await typeTextByTestId('amount-input', amount);
  const displayed = await element(by.id('satoshi-display')).getText();
  expect(displayed).toBe('100000');
});
```

### Pattern 3: Verify Data Integrity
```typescript
it('should persist data correctly', async () => {
  // Create something in UI
  await createNewWallet();

  // Verify it's stored correctly
  const wallet = await getWalletFromStorage();
  expect(wallet).toBeDefined();

  // Verify cryptographic validity
  const verification = await verifyWalletCryptography();
  expect(verification.isValid).toBe(true);
});
```

## Running Tests

```bash
# Build first
npm run e2e:build:ios

# Run tests
npm run e2e:test:ios

# Run specific file
detox test e2e/tests/02-wallet.test.ts --configuration ios.sim.debug
```

## When to Add Logic Verification

Add logic checks when testing:

- ✅ Wallet creation/import (cryptography)
- ✅ Amount entry (parsing, validation)
- ✅ Address entry (format validation)
- ✅ Balance display (calculation)
- ✅ Price display (calculations)
- ✅ Search/filter (algorithm)
- ✅ Transaction creation (fees, signatures)
- ✅ Password validation (strength)

## Examples in Codebase

See these files for complete examples:

- **`e2e/tests/08-wallet-logic.test.ts`** - Comprehensive wallet logic testing
- **`e2e/tests/02-wallet.test.ts`** - Enhanced wallet tests
- **`e2e/tests/03-transaction.test.ts`** - Enhanced transaction tests
- **`e2e/tests/04-market.test.ts`** - Enhanced market tests
- **`e2e/tests/06-tokens.test.ts`** - Enhanced token tests

## Full Documentation

- **`E2E_LOGIC_TESTING_STRATEGY.md`** - Complete strategy guide
- **`PHASE_2_IMPLEMENTATION.md`** - Phase 2 implementation details
- **`E2E_ENHANCEMENT_COMPLETE.md`** - Overall summary

## Tips

1. **Always log results**: Use `console.log()` to show verification results
2. **Test edge cases**: Verify both valid and invalid inputs
3. **Check consistency**: Ensure UI matches computed values
4. **Be specific**: Use precise expectations (e.g., exact satoshi amounts)
5. **Document why**: Add comments explaining what logic is being verified

## Questions?

See the full documentation in:
- `expo-app/e2e/E2E_LOGIC_TESTING_STRATEGY.md`
- `E2E_TESTING_SUMMARY.md`
- `PHASE_2_IMPLEMENTATION.md`
