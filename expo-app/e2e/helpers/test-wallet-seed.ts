/**
 * Test Wallet Seeds for E2E Testing
 *
 * Pre-configured wallet data for consistent testing
 * WARNING: These keys are for TESTING ONLY - never use in production
 */

import { PQKey, NetworkParameters, TestParams, Utils } from "bigtangle-ts";

/**
 * Test wallet configuration
 */
export interface TestWalletConfig {
  label: string;
  privateKey: string;
  publicKey?: string;
  address?: string;
  password: string;
}

/**
 * Pre-defined test wallets
 * These match the keys used in api.test.ts
 */
export const TEST_WALLETS: Record<string, TestWalletConfig> = {
  // Yuan token issuer wallet
  YUAN_ISSUER: {
    label: "Yuan Token Issuer",
    privateKey:
      "8db6bd17fa4a827619e165bfd4b0f551705ef2d549a799e7f07115e5c3abad55",
    publicKey:
      "02a717921ede2c066a4da05b9cdce203f1002b7e2abeee7546194498ef2fa9b13a",
    password: "TestYuanIssuer123!",
  },

  // User test wallet 1
  USER_1: {
    label: "Test User 1",
    privateKey:
      "9c845f50a809cf6bb3ff7a3679195141dc97bd62e237a2ced3d6373735a38891",
    password: "TestUser1Pass123!",
  },

  // User test wallet 2
  USER_2: {
    label: "Test User 2",
    privateKey:
      "88c8383183d9db0a5fdbd8d862709f729e055d8981b8515044f28d4cf12d3f27",
    password: "TestUser2Pass123!",
  },

  // Simple test wallet (from existing helper)
  SIMPLE_TEST: {
    label: "Simple Test Wallet",
    privateKey:
      "0000000000000000000000000000000000000000000000000000000000000001",
    address: "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm",
    password: "TestPassword123!",
  },
};

/**
 * Create PQKey from test wallet config
 */
export function createECKeyFromTestWallet(
  walletConfig: TestWalletConfig,
): PQKey {
  return PQKey.fromPrivateKey(Utils.HEX.decode(walletConfig.privateKey));
}

/**
 * Get all user test keys (for testing transactions)
 */
export function getAllUserKeys(): PQKey[] {
  return [
    createECKeyFromTestWallet(TEST_WALLETS.USER_1),
    createECKeyFromTestWallet(TEST_WALLETS.USER_2),
  ];
}

/**
 * Get yuan issuer key
 */
export function getYuanIssuerKey(): PQKey {
  return createECKeyFromTestWallet(TEST_WALLETS.YUAN_ISSUER);
}

/**
 * Create encrypted wallet file content for testing
 * This simulates what would be saved when creating a wallet in the app
 */
export function createTestWalletFileContent(
  walletConfig: TestWalletConfig,
): string {
  const key = createECKeyFromTestWallet(walletConfig);
  const networkParams = new TestParams();

  // This is a simplified version - in production, use proper encryption
  // For testing, we just create a structure similar to the real wallet file
  const walletData = {
    version: "1.0",
    address: key.toAddressWithParams(networkParams).toString(),
    publicKey: key.getPublicKeyAsHex(),
    // In a real wallet file, privateKey would be encrypted
    encryptedPrivateKey: walletConfig.privateKey, // Simplified for testing
    label: walletConfig.label,
    createdAt: new Date().toISOString(),
  };

  return JSON.stringify(walletData, null, 2);
}

/**
 * Initialize test wallets with computed addresses
 * Call this once at test setup to populate address fields
 */
export function initializeTestWallets(): void {
  Object.keys(TEST_WALLETS).forEach((key) => {
    const wallet = TEST_WALLETS[key];
    if (!wallet.address) {
      const pqKey = createECKeyFromTestWallet(wallet);
      const networkParams = new TestParams();
      wallet.address = pqKey.toAddressWithParams(networkParams).toString();
      wallet.publicKey = pqKey.getPublicKeyAsHex();
    }
  });
}

/**
 * Test wallet seed data for specific test scenarios
 */
export const TEST_SCENARIOS = {
  /**
   * User payment scenario - simulates user-to-user transactions
   */
  USER_PAYMENT: {
    sender: TEST_WALLETS.USER_1,
    receiver: TEST_WALLETS.USER_2,
    amount: BigInt(1000000), // 0.01 BIG
  },

  /**
   * Token creation scenario
   */
  TOKEN_CREATION: {
    issuer: TEST_WALLETS.YUAN_ISSUER,
    tokenName: "Test Yuan Token",
    tokenSymbol: "TYUAN",
    totalSupply: BigInt(1000000) * BigInt(100000000), // 1M tokens with 8 decimals
  },

  /**
   * Token transfer scenario
   */
  TOKEN_TRANSFER: {
    sender: TEST_WALLETS.USER_1,
    receiver: TEST_WALLETS.USER_2,
    tokenAmount: BigInt(100) * BigInt(100000000), // 100 tokens
  },
};

/**
 * Default test configuration
 */
export const DEFAULT_TEST_CONFIG = {
  networkTimeout: 30000, // 30 seconds
  blockConfirmationWait: 5000, // 5 seconds
  balanceCheckInterval: 2000, // 2 seconds
  maxBalanceWaitTime: 30000, // 30 seconds
};

// Initialize wallet addresses on module load
initializeTestWallets();
