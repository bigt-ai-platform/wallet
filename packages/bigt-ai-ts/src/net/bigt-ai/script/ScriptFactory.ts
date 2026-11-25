/**
 * ScriptFactory - Factory pattern to break circular dependencies
 * 
 * This factory provides lazy instantiation of Script objects to avoid
 * circular dependency issues during module initialization.
 * 
 * The circular dependency chain was:
 * Script -> TransactionOutput -> Script (via import)
 * Script -> TransactionInput -> TransactionOutput -> Script
 * 
 * By using this factory, TransactionOutput and TransactionInput can
 * create Script instances without directly importing the Script class
 * during module initialization.
 */

import type { Script } from './Script';

// Lazy reference to Script class - only loaded when first needed
let _ScriptClass: typeof Script | null = null;

/**
 * Get the Script class (lazy loaded)
 */
async function getScriptClass(): Promise<typeof Script> {
  if (_ScriptClass === null) {
    const module = await import('./Script.js');
    _ScriptClass = module.Script;
  }
  return _ScriptClass;
}

/**
 * ScriptFactory - provides methods to create Script instances without direct imports
 */
export class ScriptFactory {
  private static scriptClass: typeof Script | null = null;

  /**
   * Initialize the factory with the Script class (called during app initialization)
   */
  static initialize(scriptClass: typeof Script): void {
    ScriptFactory.scriptClass = scriptClass;
  }

  /**
   * Create a new Script instance from program bytes
   * @param program The script program bytes
   * @returns A new Script instance
   */
  static createScript(program: Uint8Array): Script {
    if (!ScriptFactory.scriptClass) {
      throw new Error('ScriptFactory not initialized. Call ScriptFactory.initialize() first.');
    }
    return new ScriptFactory.scriptClass(program);
  }

  /**
   * Check if the factory is initialized
   */
  static isInitialized(): boolean {
    return ScriptFactory.scriptClass !== null;
  }

  /**
   * Get the Script class for advanced usage
   * @throws Error if not initialized
   */
  static getScriptClass(): typeof Script {
    if (!ScriptFactory.scriptClass) {
      throw new Error('ScriptFactory not initialized. Call ScriptFactory.initialize() first.');
    }
    return ScriptFactory.scriptClass;
  }
}

/**
 * Auto-initialize on import (for backwards compatibility)
 * This uses dynamic import to avoid circular dependency
 */
if (typeof window !== 'undefined' || typeof global !== 'undefined') {
  // Browser or Node.js environment
  getScriptClass().then((ScriptClass) => {
    ScriptFactory.initialize(ScriptClass);
  }).catch((err) => {
    console.error('Failed to auto-initialize ScriptFactory:', err);
  });
}
