# E2E Testing Guide

## Overview

This project uses **Detox** for end-to-end testing on iOS and Android platforms.

## Prerequisites

### iOS
- macOS
- Xcode 14+ installed
- iOS Simulator
- Detox CLI: `npm install -g detox-cli`

### Android
- Android Studio
- Android SDK
- Android Emulator (API 31 recommended)
- Detox CLI: `npm install -g detox-cli`

## Setup

### 1. Install Dependencies

```bash
cd expo-app
yarn add -D detox jest
```

### 2. Install Detox CLI

```bash
npm install -g detox-cli
```

### 3. Generate Native Projects

```bash
yarn prebuild
```

This generates the `ios/` and `android/` directories needed for Detox.

## Running Tests

### iOS

```bash
# Build app
detox build --configuration ios.sim.debug

# Run tests
detox test --configuration ios.sim.debug

# Run specific test file
detox test --configuration ios.sim.debug e2e/tests/01-app-launch.test.ts

# Run with specific simulator
detox test --configuration ios.sim.debug --device-name="iPhone 15"
```

### Android

```bash
# Start emulator first
emulator -avd Pixel_5_API_31

# Build app
detox build --configuration android.emu.debug

# Run tests
detox test --configuration android.emu.debug

# Run specific test file
detox test --configuration android.emu.debug e2e/tests/01-app-launch.test.ts
```

### Additional Options

```bash
# Run tests with screenshots
detox test --configuration ios.sim.debug --take-screenshots all

# Run tests with video recording
detox test --configuration ios.sim.debug --record-videos all

# Run tests in debug mode
detox test --configuration ios.sim.debug --loglevel trace

# Run tests on physical device
detox test --configuration android.att.debug
```

## Test Structure

```
e2e/
├── helpers/
│   ├── setup.ts           # General test helpers
│   └── wallet.ts          # Wallet-specific helpers
├── tests/
│   ├── 01-app-launch.test.ts      # App launch and navigation
│   ├── 02-wallet.test.ts          # Wallet management
│   ├── 03-transaction.test.ts     # Transaction sending
│   ├── 04-market.test.ts          # Market data
│   ├── 05-settings.test.ts        # Settings
│   ├── 06-tokens.test.ts          # Token browsing and search
│   └── 07-aichat.test.ts          # AI chat functionality
├── jest.config.js         # Jest configuration
└── E2E_TESTING.md        # This file
```

## Test Scenarios

### 1. App Launch (`01-app-launch.test.ts`)
- ✅ App launches successfully
- ✅ Tab navigation is visible
- ✅ Navigate between tabs
- ✅ Handle app state changes
- ✅ Orientation changes

### 2. Wallet Management (`02-wallet.test.ts`)
- ✅ Create new wallet
- ✅ Import wallet from private key
- ✅ Lock/unlock wallet
- ✅ Auto-lock on background
- ✅ Display wallet address and balances
- ✅ Validate passwords
- ✅ Handle errors

### 3. Transactions (`03-transaction.test.ts`)
- ✅ Display transaction form
- ✅ Select tokens
- ✅ Validate recipient address
- ✅ Validate amount
- ✅ Add memo
- ✅ Show confirmation dialog
- ✅ Send transaction
- ✅ Handle errors

### 4. Market (`04-market.test.ts`)
- ✅ Display market prices
- ✅ Show price changes
- ✅ Refresh data
- ✅ Handle empty state
- ✅ Handle network errors

### 5. Settings (`05-settings.test.ts`)
- ✅ Display settings
- ✅ Toggle testnet
- ✅ Update server URL
- ✅ Reset to defaults
- ✅ Display app info
- ✅ Persist settings

### 6. Tokens (`06-tokens.test.ts`)
- ✅ Display token list
- ✅ Search tokens by name
- ✅ Search tokens by ID
- ✅ Show loading state
- ✅ Handle empty state
- ✅ Scroll and refresh
- ✅ Display token metadata
- ✅ Performance testing

### 7. AI Chat (`07-aichat.test.ts`)
- ✅ Display chat interface
- ✅ Send messages
- ✅ Display responses
- ✅ Handle loading state
- ✅ Handle errors
- ✅ Maintain conversation history
- ✅ Auto-scroll to latest message
- ✅ Keyboard behavior
- ✅ Multiline input support

## Helper Functions

### Setup Helpers (`helpers/setup.ts`)

```typescript
// Wait for elements
waitForElementToBeVisible(matcher, timeout)
waitForElementToExist(matcher, timeout)

// Interact with elements
tapByTestId(testId)
typeTextByTestId(testId, text)
clearTextByTestId(testId)

// Navigation
navigateToTab(tabIndex)
navigateToTabByName(tabName)

// App state
resetApp()
reloadReactNative()
sendToBackgroundAndResume(duration)

// Utilities
takeScreenshot(name)
waitForNetwork(timeMs)
elementExists(testId)
```

### Wallet Helpers (`helpers/wallet.ts`)

```typescript
// Wallet management
createNewWallet(password)
importWalletFromKey(privateKey, password)
unlockWallet(password)
lockWallet()
clearWallet()

// Wallet data
checkWalletBalance(tokenName)
getWalletAddress()
exportWalletFile()

// Test data
TEST_WALLET = {
  password: 'TestPassword123!',
  privateKey: '...',
  address: '...',
}
```

## Writing New Tests

### Basic Test Structure

```typescript
import { device, element, by, expect as detoxExpect } from 'detox';
import { waitForAppToBeReady, tapByTestId } from '../helpers/setup';

describe('Feature Name', () => {
  beforeAll(async () => {
    await device.launchApp();
    await waitForAppToBeReady();
  });

  beforeEach(async () => {
    // Setup before each test
  });

  it('should do something', async () => {
    // Test implementation
    await tapByTestId('button-id');
    await detoxExpect(element(by.id('result'))).toBeVisible();
  });
});
```

### Test IDs

Add `testID` props to React Native components for easy selection:

```typescript
<View testID="transaction-screen">
  <TouchableOpacity testID="send-button" onPress={handleSend}>
    <Text>Send</Text>
  </TouchableOpacity>
</View>
```

Then in tests:

```typescript
await tapByTestId('send-button');
await detoxExpect(element(by.id('transaction-screen'))).toBeVisible();
```

## Best Practices

### 1. Use Test IDs
Always add `testID` props to interactive elements:

```typescript
<Button testID="login-button" onPress={...} />
```

### 2. Wait for Elements
Always wait for elements before interacting:

```typescript
await waitForElementToBeVisible(by.id('button'));
await element(by.id('button')).tap();
```

### 3. Clean Up
Reset app state between tests:

```typescript
beforeEach(async () => {
  await resetApp();
});
```

### 4. Use Helper Functions
Create reusable helpers for common actions:

```typescript
async function login(username, password) {
  await typeTextByTestId('username', username);
  await typeTextByTestId('password', password);
  await tapByTestId('login-button');
}
```

### 5. Take Screenshots
Take screenshots for debugging and documentation:

```typescript
await takeScreenshot('feature-name');
```

### 6. Handle Async Operations
Wait for network requests to complete:

```typescript
await waitForNetwork(2000);
await detoxExpect(element(by.id('result'))).toBeVisible();
```

### 7. Test Error Cases
Always test both success and error scenarios:

```typescript
it('should handle invalid input', async () => {
  await typeTextByTestId('input', 'invalid');
  await tapByTestId('submit');
  await detoxExpect(element(by.text('Error'))).toBeVisible();
});
```

## Debugging

### View Hierarchy
Use Detox synchronization logs:

```bash
detox test --loglevel trace
```

### Screenshots
Enable automatic screenshots:

```bash
detox test --take-screenshots failing  # Only failing tests
detox test --take-screenshots all      # All tests
```

### Video Recording
Record test execution:

```bash
detox test --record-videos failing
```

### Debug Mode
Run tests with debugger attached:

```bash
detox test --debug-synchronization 500
```

### Check Element Attributes
```typescript
await element(by.id('element')).getAttributes();
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v2
      - name: Install dependencies
        run: yarn install
      - name: Build app
        run: detox build --configuration ios.sim.release
      - name: Run tests
        run: detox test --configuration ios.sim.release --cleanup
      - name: Upload screenshots
        if: failure()
        uses: actions/upload-artifact@v2
        with:
          name: ios-screenshots
          path: artifacts/

  test-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Install dependencies
        run: yarn install
      - name: Build app
        run: detox build --configuration android.emu.release
      - name: Run tests
        run: detox test --configuration android.emu.release --headless
      - name: Upload screenshots
        if: failure()
        uses: actions/upload-artifact@v2
        with:
          name: android-screenshots
          path: artifacts/
```

## Common Issues

### Issue: "App not found"
**Solution**: Run `yarn prebuild` to generate native projects

### Issue: "Cannot find simulator"
**Solution**:
```bash
# List available simulators
xcrun simctl list devices

# Boot a simulator
open -a Simulator
```

### Issue: "Tests timeout"
**Solution**: Increase timeout in test:

```typescript
it('should do something', async () => {
  // ...
}, 60000); // 60 second timeout
```

### Issue: "Element not found"
**Solution**:
1. Add `testID` to component
2. Wait for element: `await waitForElementToBeVisible(...)`
3. Check element hierarchy: `detox test --loglevel trace`

### Issue: "Android emulator not starting"
**Solution**:
```bash
# Start emulator manually
emulator -avd Pixel_5_API_31

# Check if running
adb devices
```

## Test Coverage

Current test coverage:
- ✅ App launch and navigation
- ✅ Wallet creation and import
- ✅ Wallet lock/unlock
- ✅ Transaction form validation
- ✅ Market data display
- ✅ Settings configuration

Planned test coverage:
- ⏳ QR code scanning
- ⏳ Transaction history
- ⏳ Contact management
- ⏳ Network error handling
- ⏳ Performance tests
- ✅ Token browsing and search
- ✅ AI chat functionality

## Resources

- [Detox Documentation](https://wix.github.io/Detox/)
- [Detox API Reference](https://wix.github.io/Detox/docs/api/actions)
- [Detox Troubleshooting](https://wix.github.io/Detox/docs/troubleshooting/overview)
- [Expo + Detox Guide](https://docs.expo.dev/guides/detox/)

## Support

For issues with e2e tests:
1. Check this documentation
2. Review Detox logs: `detox test --loglevel trace`
3. Check screenshots in `artifacts/` directory
4. Verify test IDs in components
5. Ensure simulators/emulators are running

## Maintenance

### Updating Tests
When adding new features:
1. Add `testID` props to new components
2. Create test file in `e2e/tests/`
3. Add helper functions if needed
4. Update this documentation
5. Run tests locally before committing

### Test Cleanup
Regularly:
1. Remove obsolete tests
2. Update test IDs if components change
3. Refactor duplicate code into helpers
4. Update documentation
5. Review and fix flaky tests
