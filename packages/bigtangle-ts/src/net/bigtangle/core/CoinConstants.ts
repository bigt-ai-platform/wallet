import { MonetaryFormat } from "../utils/MonetaryFormat";
import { NetworkParameters } from "../params/NetworkParameters";

// Try to import Coin to set up the reference when module is loaded
try {
  // Dynamic import to avoid circular dependencies during module loading
  import('./Coin').then((module) => {
    if (module.Coin) {
      (CoinConstants as any)._setCoinReference(module.Coin);
    }
  }).catch(() => {
    // If Coin can't be imported, that's ok - we'll use plain objects
  });
} catch (e) {
  // Silent fail if imports can't be done
}

/**
 * Factory class for Coin constants to avoid circular dependency issues
 * during module initialization due to static initialization order.
 *
 * Note: This implementation now uses its own implementations to avoid
 * circular dependencies.
 */
export class CoinConstants {
  // Define the default token ID as a constant to ensure consistency
  private static readonly DEFAULT_TOKEN_ID = (() => {
    const tokenString = "bc";
    const bytes: number[] = [];
    for (let i = 0; i < tokenString.length; i += 2) {
      bytes.push(parseInt(tokenString.substr(i, 2), 16));
    }
    return new Uint8Array(bytes);
  })();

  // Define constants using lazy initialization for compatibility
  private static _ZERO: any | null = null;
  private static _COIN: any | null = null;
  private static _SATOSHI: any | null = null;
  private static _NEGATIVE_SATOSHI: any | null = null;
  private static _FEE_DEFAULT: any | null = null;

  public static get ZERO(): any {
    if (CoinConstants._ZERO === null) {
      CoinConstants._ZERO = CoinConstants.createCoinProperly(0n);
    }
    return CoinConstants._ZERO;
  }

  public static get COIN(): any {
    if (CoinConstants._COIN === null) {
      CoinConstants._COIN = CoinConstants.createCoinProperly(1000000n);
    }
    return CoinConstants._COIN;
  }

  public static get SATOSHI(): any {
    if (CoinConstants._SATOSHI === null) {
      CoinConstants._SATOSHI = CoinConstants.createCoinProperly(1n);
    }
    return CoinConstants._SATOSHI;
  }

  public static get NEGATIVE_SATOSHI(): any {
    if (CoinConstants._NEGATIVE_SATOSHI === null) {
      CoinConstants._NEGATIVE_SATOSHI = CoinConstants.createCoinProperly(-1n);
    }
    return CoinConstants._NEGATIVE_SATOSHI;
  }

  public static get FEE_DEFAULT(): any {
    if (CoinConstants._FEE_DEFAULT === null) {
      CoinConstants._FEE_DEFAULT = CoinConstants.createCoinProperly(1000n);
    }
    return CoinConstants._FEE_DEFAULT;
  }


  private static createCoin(value: bigint) {
    // Create a self-contained Coin-like object with full interface compatibility
    // This avoids the circular dependency entirely
    const tokenid = CoinConstants.DEFAULT_TOKEN_ID;

    // Create an object that mimics the Coin class interface
    const coinInstance: any = {
      value: value,
      tokenid: tokenid,
      signum: function(): number {
        return value > 0n ? 1 : value < 0n ? -1 : 0;
      },
      isPositive: function(): boolean {
        return value > 0n;
      },
      isNegative: function(): boolean {
        return value < 0n;
      },
      isZero: function(): boolean {
        return value === 0n;
      },
      isBIG: function(): boolean {
        // Check if tokenid matches the default token id
        return CoinConstants.arraysEqual(tokenid, CoinConstants.DEFAULT_TOKEN_ID);
      },
      isGreaterThan: function(other: any): boolean {
        return coinInstance.compareTo(other) > 0;
      },
      compareTo: function(other: any): number {
        if (value > other.value) return 1;
        if (value < other.value) return -1;
        return 0;
      },
      equals: function(other: any): boolean {
        return other &&
               other.value === value &&
               CoinConstants.arraysEqual(other.tokenid, tokenid);
      },
      negate: function() {
        return CoinConstants.createCoin(-value);
      },
      add: function(other: any) {
        if (!CoinConstants.arraysEqual(coinInstance.tokenid, other.tokenid)) {
          throw new Error("Token IDs must match for addition");
        }
        const result = value + other.value;
        return CoinConstants.createCoin(result);
      },
      subtract: function(other: any) {
        if (!CoinConstants.arraysEqual(coinInstance.tokenid, other.tokenid)) {
          throw new Error("Token IDs must match for subtraction");
        }
        const result = value - other.value;
        return CoinConstants.createCoin(result);
      },
      multiply: function(factor: bigint | number) {
        if (typeof factor === "number") factor = BigInt(factor);
        const result = value * factor;
        return CoinConstants.createCoin(result);
      },
      divide: function(divisor: bigint | number) {
        if (typeof divisor === "number") divisor = BigInt(divisor);
        if (divisor === 0n) {
          throw new Error("Division by zero");
        }
        const result = value / divisor;
        return CoinConstants.createCoin(result);
      },
      getValue: function(): bigint {
        return value;
      },
      getTokenid: function(): Uint8Array {
        return tokenid;
      },
      getTokenHex: function(): string {
        return Array.from(tokenid)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
      },
      toString: function(): string {
        return `[${value.toString()}:${coinInstance.getTokenHex()}]`;
      },
      toJSON: function() {
        return {
          value: value.toString(),
          tokenid: Array.from(tokenid)
            .map(b => b.toString(16).padStart(2, '0'))
            .join(''),
        };
      },
      hashCode: function(): number {
        const prime = 31;
        let result = 1;
        const tokenHex = Array.from(tokenid)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        const valueStr = value.toString();
        result = prime * result + coinInstance.stringHashCode(tokenHex);
        result = prime * result + coinInstance.stringHashCode(valueStr);
        return result;
      },
      stringHashCode: function(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash |= 0; // Convert to 32bit integer
        }
        return hash;
      }
    };

    return coinInstance;
  }

  private static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  public static get FIAT(): MonetaryFormat {
    return new MonetaryFormat()
      .withShift(0)
      .withMinDecimals(0);
  }

  /**
   * Resets all cached constants (useful for testing)
   */
  public static reset(): void {
    // No-op in this implementation since we're referencing Coin class constants
  }

  /**
   * Creates a standard Coin value with appropriate token ID
   * @deprecated Use Coin.valueOf directly instead
   */
  public static createStandardCoin(satoshis: bigint): any {
    return CoinConstants.createCoin(satoshis);
  }

  /**
   * Method to set the Coin class reference after both modules are loaded
   * This should be called after modules are fully loaded to avoid circular dependency
   * @private
   */
  public static _setCoinReference(CoinClass: any): void {
    (CoinConstants as any)._Coin = CoinClass;
    // Reset constants so they can be recreated with the proper Coin class
    CoinConstants._ZERO = null;
    CoinConstants._COIN = null;
    CoinConstants._SATOSHI = null;
    CoinConstants._NEGATIVE_SATOSHI = null;
    CoinConstants._FEE_DEFAULT = null;
  }

  /**
   * Creates a proper Coin instance when possible, or falls back to plain object
   */
  private static createCoinProperly(value: bigint): any {
    // If we have a reference to the Coin class, use it
    if ((CoinConstants as any)._Coin) {
      return new (CoinConstants as any)._Coin(value, CoinConstants.DEFAULT_TOKEN_ID);
    }
    // Otherwise, use the plain object implementation
    return CoinConstants.createCoin(value);
  }

}

export default CoinConstants;