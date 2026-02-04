/**
 * Test Wallet Initialization Helper
 *
 * Utilities to seed test wallets into the app for E2E testing
 */

import {
  TEST_WALLETS,
  createECKeyFromTestWallet,
  type TestWalletConfig,
} from "./test-wallet-seed";
import {
  createWallet,
  saveKeyToFile,
  importPrivateKey,
} from "../../sources/screens/wallet/WalletHelper";
import { TestParams } from "bigtangle-ts";

/**
 * Initialize a test wallet in the app storage
 * This simulates creating/importing a wallet through the UI
 */
export async function initializeTestWalletInApp(
  walletConfig: TestWalletConfig,
  storeFunction: (
    encryptedContent: string,
    address: string,
    password: string,
  ) => Promise<void>,
): Promise<{ address: string; encryptedContent: string }> {
  try {
    // Import the wallet from private key
    const wallet = await importPrivateKey(walletConfig.privateKey);

    // Save it with the test password
    const encryptedContent = await saveKeyToFile(wallet, walletConfig.password);

    // Store in app storage
    await storeFunction(
      encryptedContent,
      wallet.wallet.address,
      walletConfig.password,
    );

    console.log(`✓ Initialized test wallet: ${walletConfig.label}`);
    console.log(`  Address: ${wallet.wallet.address}`);

    return {
      address: wallet.wallet.address,
      encryptedContent,
    };
  } catch (error) {
    console.error(
      `✗ Failed to initialize test wallet ${walletConfig.label}:`,
      error,
    );
    throw error;
  }
}

/**
 * Seed all test wallets into app storage
 * Use this to prepare the app with test wallets before running E2E tests
 */
export async function seedAllTestWallets(
  storeFunction: (
    encryptedContent: string,
    address: string,
    password: string,
  ) => Promise<void>,
): Promise<Map<string, { address: string; encryptedContent: string }>> {
  const results = new Map();

  console.log("Seeding test wallets...");

  for (const [key, walletConfig] of Object.entries(TEST_WALLETS)) {
    const result = await initializeTestWalletInApp(walletConfig, storeFunction);
    results.set(key, result);
  }

  console.log(`✓ Seeded ${results.size} test wallets`);

  return results;
}

/**
 * Create a wallet file for download/import testing
 * Returns the encrypted content that can be saved to a .json file
 */
export async function createTestWalletFile(
  walletConfig: TestWalletConfig,
): Promise<string> {
  const wallet = await importPrivateKey(walletConfig.privateKey);
  return await saveKeyToFile(wallet, walletConfig.password);
}

/**
 * Verify a test wallet is correctly initialized
 */
export async function verifyTestWallet(
  encryptedContent: string,
  password: string,
  expectedAddress: string,
): Promise<boolean> {
  try {
    const { loadWallet } =
      await import("../../sources/screens/wallet/WalletHelper");
    const wallet = await loadWallet(encryptedContent, password);
    return wallet.wallet.address === expectedAddress;
  } catch (error) {
    console.error("Failed to verify test wallet:", error);
    return false;
  }
}

/**
 * Setup function to be called at the start of E2E tests
 * This prepares the test environment with known wallets
 */
export async function setupTestWalletEnvironment(
  walletKey: keyof typeof TEST_WALLETS = "USER_1",
): Promise<TestWalletConfig> {
  const walletConfig = TEST_WALLETS[walletKey];

  console.log("Setting up test wallet environment...");
  console.log(`  Wallet: ${walletConfig.label}`);
  console.log(`  Password: ${walletConfig.password}`);

  // Create the wallet file content
  const encryptedContent = await createTestWalletFile(walletConfig);

  console.log("✓ Test wallet environment ready");

  return walletConfig;
}

/**
 * Get test wallet credentials for UI automation
 */
export function getTestWalletCredentials(
  walletKey: keyof typeof TEST_WALLETS = "USER_1",
): { password: string; privateKey: string; label: string } {
  const wallet = TEST_WALLETS[walletKey];
  return {
    password: wallet.password,
    privateKey: wallet.privateKey,
    label: wallet.label,
  };
}

/**
 * Export wallet data for manual testing or debugging
 */
export function exportTestWalletInfo(
  walletKey: keyof typeof TEST_WALLETS,
): void {
  const wallet = TEST_WALLETS[walletKey];
  const ecKey = createECKeyFromTestWallet(wallet);
  const networkParams = new TestParams();

  console.log("=".repeat(60));
  console.log(`Test Wallet: ${wallet.label}`);
  console.log("=".repeat(60));
  console.log(`Address:     ${ecKey.toAddress(networkParams).toString()}`);
  console.log(`Public Key:  ${ecKey.getPublicKeyAsHex()}`);
  console.log(`Private Key: ${wallet.privateKey}`);
  console.log(`Password:    ${wallet.password}`);
  console.log("=".repeat(60));
  console.log("⚠️  WARNING: This is test data only - NEVER use in production!");
  console.log("=".repeat(60));
}
