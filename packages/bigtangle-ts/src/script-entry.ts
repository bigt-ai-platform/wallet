/**
 * Dedicated script entry point to resolve circular dependencies
 * 
 * This module provides a Script class that can be safely imported
 * without circular dependency issues.
 */

// Create a temporary class to hold the Script until it's fully loaded
let ScriptClass: any = null;

// Use a factory function to ensure Script is loaded before access
const getScriptClass = async () => {
  if (!ScriptClass) {
    // Dynamically import the Script class to avoid circular dependency
    const { Script } = await import('./net/bigtangle/script/Script');
    ScriptClass = Script;
  }
  return ScriptClass;
};

// Export a proxy that loads Script on first access
export const Script = new Proxy({}, {
  get: async (target: any, prop: string) => {
    const ScriptCls = await getScriptClass();
    const value = ScriptCls[prop];
    
    // If it's a function, bind it to the class
    if (typeof value === 'function') {
      return value.bind(ScriptCls);
    }
    return value;
  },
  construct: async (target: any, args: any[]) => {
    const ScriptCls = await getScriptClass();
    return new ScriptCls(...args);
  }
}) as any;

// Alternative approach: export a promise-based factory
export const createScript = async (...args: any[]) => {
  const ScriptCls = await getScriptClass();
  return new ScriptCls(...args);
};

export default Script;