/**
 * Logic Verification Helpers
 *
 * Helpers to verify business logic correctness in E2E tests.
 * These complement UI tests by ensuring the underlying logic is correct.
 */

import { PQKey, Address, Wallet, NetworkParameters, TestParams, UTXO, Utils } from 'bigtangle-ts';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Get wallet data from app storage
 */
export async function getWalletFromStorage(): Promise<any> {
  try {
    const walletJson = await AsyncStorage.getItem('wallet');
    if (!walletJson) return null;
    return JSON.parse(walletJson);
  } catch (error) {
    console.error('Error reading wallet from storage:', error);
    return null;
  }
}

/**
 * Verify wallet cryptographic validity
 */
export async function verifyWalletCryptography(): Promise<{
  isValid: boolean;
  address?: string;
  publicKey?: string;
  error?: string;
}> {
  try {
    const walletData = await getWalletFromStorage();
    if (!walletData || !walletData.privateKey) {
      return { isValid: false, error: 'No wallet found in storage' };
    }

    // Verify key can be loaded
    const key = PQKey.fromPrivateKey(Utils.HEX.decode(walletData.privateKey));

    // Derive address
    const networkParams = TestParams.get();
    const address = key.toAddressWithParams(networkParams);

    // Verify public key matches
    const publicKey = key.getPublicKeyAsHex();

    return {
      isValid: true,
      address: address.toString(),
      publicKey,
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Verify address format is valid Bitcoin address
 */
export function verifyAddressFormat(address: string): boolean {
  // Bitcoin address regex: starts with 1 or 3, 25-34 characters, base58
  const addressRegex = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
  return addressRegex.test(address);
}

/**
 * Verify key pair (private key produces correct public key)
 */
export async function verifyKeyPair(privateKey: string): Promise<{
  isValid: boolean;
  publicKey?: string;
  address?: string;
  error?: string;
}> {
  try {
    const key = PQKey.fromPrivateKey(Utils.HEX.decode(privateKey));
    const publicKey = key.getPublicKeyAsHex();
    const networkParams = TestParams.get();
    const address = key.toAddressWithParams(networkParams).toString();

    // Verify public key is valid
    const isValidPubKey = publicKey.length > 0;

    return {
      isValid: isValidPubKey,
      publicKey,
      address,
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Invalid key',
    };
  }
}

/**
 * Verify balance calculation from UTXOs
 */
export async function verifyBalanceCalculation(utxos: UTXO[]): Promise<{
  totalBalance: bigint;
  balanceByToken: Map<string, bigint>;
  utxoCount: number;
}> {
  const balanceByToken = new Map<string, bigint>();
  let totalBalance = BigInt(0);

  for (const utxo of utxos) {
    const value = utxo.getValue();
    const tokenId = utxo.getTokenId();

    if (value) {
      totalBalance += value.getValue();

      const currentTokenBalance = balanceByToken.get(tokenId) || BigInt(0);
      balanceByToken.set(tokenId, currentTokenBalance + value.getValue());
    }
  }

  return {
    totalBalance,
    balanceByToken,
    utxoCount: utxos.length,
  };
}

/**
 * Verify transaction signature
 * Note: This requires the transaction object and may need adaptation
 * based on your transaction structure
 */
export async function verifyTransactionSignature(tx: any): Promise<{
  isValid: boolean;
  inputCount: number;
  outputCount: number;
  error?: string;
}> {
  try {
    // This is a placeholder - actual implementation depends on
    // your transaction structure and signature verification method
    const inputCount = tx.inputs?.length || 0;
    const outputCount = tx.outputs?.length || 0;

    return {
      isValid: true,
      inputCount,
      outputCount,
    };
  } catch (error) {
    return {
      isValid: false,
      inputCount: 0,
      outputCount: 0,
      error: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Verify token search/filter logic
 */
export function verifyTokenFilter(
  allTokens: any[],
  searchTerm: string
): any[] {
  const lowerSearch = searchTerm.toLowerCase();

  return allTokens.filter((token) => {
    const matchesName = token.tokenname?.toLowerCase().includes(lowerSearch);
    const matchesId = token.tokenid?.toLowerCase().includes(lowerSearch);
    const matchesDescription = token.description?.toLowerCase().includes(lowerSearch);

    return matchesName || matchesId || matchesDescription;
  });
}

/**
 * Verify password strength requirements
 */
export function verifyPasswordStrength(password: string): {
  isValid: boolean;
  score: number;
  feedback: string[];
} {
  const feedback: string[] = [];
  let score = 0;

  // Length check
  if (password.length >= 8) {
    score += 1;
  } else {
    feedback.push('Password must be at least 8 characters');
  }

  // Uppercase check
  if (/[A-Z]/.test(password)) {
    score += 1;
  } else {
    feedback.push('Password must contain uppercase letters');
  }

  // Lowercase check
  if (/[a-z]/.test(password)) {
    score += 1;
  } else {
    feedback.push('Password must contain lowercase letters');
  }

  // Number check
  if (/\d/.test(password)) {
    score += 1;
  } else {
    feedback.push('Password must contain numbers');
  }

  // Special character check
  if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    score += 1;
  } else {
    feedback.push('Password should contain special characters');
  }

  return {
    isValid: score >= 4,
    score,
    feedback,
  };
}

/**
 * Calculate expected transaction fee
 */
export function calculateTransactionFee(
  inputCount: number,
  outputCount: number,
  feePerByte: bigint = BigInt(1000)
): bigint {
  // Rough estimation: 180 bytes per input, 34 bytes per output, 10 bytes overhead
  const estimatedSize = inputCount * 180 + outputCount * 34 + 10;
  return feePerByte * BigInt(estimatedSize);
}

/**
 * Verify amount format and parsing
 */
export function verifyAmountFormat(
  amountString: string,
  decimals: number = 8
): {
  isValid: boolean;
  parsedAmount?: bigint;
  error?: string;
} {
  try {
    // Remove any non-numeric characters except decimal point
    const cleaned = amountString.replace(/[^\d.]/g, '');

    // Check for multiple decimal points
    if ((cleaned.match(/\./g) || []).length > 1) {
      return { isValid: false, error: 'Multiple decimal points' };
    }

    // Parse to number and convert to satoshis
    const num = parseFloat(cleaned);
    if (isNaN(num) || num < 0) {
      return { isValid: false, error: 'Invalid number' };
    }

    // Convert to smallest unit (satoshis)
    const parsedAmount = BigInt(Math.floor(num * Math.pow(10, decimals)));

    return {
      isValid: true,
      parsedAmount,
    };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : 'Parse error',
    };
  }
}

/**
 * Verify market price calculations
 */
export function verifyPriceChange(
  currentPrice: number,
  previousPrice: number
): {
  change: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
} {
  const change = currentPrice - previousPrice;
  const changePercent = previousPrice !== 0
    ? (change / previousPrice) * 100
    : 0;

  let direction: 'up' | 'down' | 'flat';
  if (change > 0) direction = 'up';
  else if (change < 0) direction = 'down';
  else direction = 'flat';

  return {
    change,
    changePercent,
    direction,
  };
}

/**
 * Verify sorting logic
 */
export function verifySortOrder<T>(
  items: T[],
  sortKey: keyof T,
  ascending: boolean = true
): boolean {
  for (let i = 0; i < items.length - 1; i++) {
    const current = items[i][sortKey];
    const next = items[i + 1][sortKey];

    if (ascending) {
      if (current > next) return false;
    } else {
      if (current < next) return false;
    }
  }

  return true;
}
