/**
 * ScriptHelper - Breaks circular dependencies using global registration
 * 
 * CRITICAL: This file must NOT have any static imports from:
 * - TransactionInput
 * - TransactionOutput  
 * - Script (only type import allowed)
 * 
 * The Script class is registered globally by Script.ts when it loads.
 * This ensures the circular dependency is broken because Script is only
 * accessed AFTER all modules have completed their initialization.
 */

// Type-only import (erased at runtime, causes no circular dependency)
import type { Script as ScriptType } from './Script';

// Cached Script class reference - populated from globalThis or explicit registration
let _ScriptClass: typeof ScriptType | null = null;
let _allVerifyFlags: Set<any> | null = null;

/**
 * Register the Script class. Can be called by index.ts to pre-register.
 * Script.ts also self-registers via globalThis.
 */
export function registerScriptClass(scriptClass: typeof ScriptType): void {
  _ScriptClass = scriptClass;
  _allVerifyFlags = (scriptClass as any).ALL_VERIFY_FLAGS;
}

/**
 * Check if Script class has been registered.
 */
export function isScriptRegistered(): boolean {
  return _ScriptClass !== null || (globalThis as any).__SCRIPT_CLASS__ !== undefined;
}

/**
 * Get the Script class, checking globalThis if not explicitly registered.
 */
function getScriptClass(): typeof ScriptType {
  if (_ScriptClass === null) {
    // Try to get from globalThis (set by Script.ts when it loads)
    const globalScript = (globalThis as any).__SCRIPT_CLASS__;
    if (globalScript) {
      _ScriptClass = globalScript;
      _allVerifyFlags = globalScript.ALL_VERIFY_FLAGS;
    }
  }
  
  if (_ScriptClass === null) {
    throw new Error(
      'Script class not yet registered. ' +
      'Make sure to import from the main index.ts entry point, not directly from individual modules.'
    );
  }
  return _ScriptClass;
}

/**
 * ScriptHelper provides factory methods for creating Script instances
 * without causing circular dependency issues during module initialization.
 * 
 * Usage:
 * ```typescript
 * import { ScriptHelper } from '../script/ScriptHelper';
 * 
 * // Instead of: new Script(bytes)
 * const script = ScriptHelper.fromBytes(bytes);
 * 
 * // Instead of: Script.ALL_VERIFY_FLAGS
 * const flags = ScriptHelper.getAllVerifyFlags();
 * ```
 */
export class ScriptHelper {
  /**
   * Create a Script instance from program bytes.
   * This is the safe way to instantiate Script from TransactionOutput/TransactionInput.
   * 
   * @param programBytes The script program as bytes
   * @returns A new Script instance
   */
  static fromBytes(programBytes: Uint8Array): ScriptType {
    const ScriptClass = getScriptClass();
    return new ScriptClass(programBytes);
  }

  /**
   * Get the ALL_VERIFY_FLAGS constant from Script namespace.
   * 
   * @returns Set of all verification flags
   */
  static getAllVerifyFlags(): Set<any> {
    // Make sure Script is loaded and get flags from it
    const ScriptClass = getScriptClass();
    if (_allVerifyFlags === null) {
      _allVerifyFlags = (ScriptClass as any).ALL_VERIFY_FLAGS;
    }
    return _allVerifyFlags!;
  }

  /**
   * Get the Script class itself for advanced usage.
   * Use sparingly - prefer the factory methods above.
   * 
   * @returns The Script class
   */
  static getScriptClass(): typeof ScriptType {
    return getScriptClass();
  }
}
