import { Script } from './Script';
import { ScriptChunk } from './ScriptChunk';

export class ScriptProvider {
    // Empty class for now, just for interface compatibility
}

// Global instance to be used when dependency injection isn't possible
let globalScriptProvider: ScriptProvider | null = null;

export function getGlobalScriptProvider(): ScriptProvider {
    if (!globalScriptProvider) {
        globalScriptProvider = new ScriptProvider();
    }
    return globalScriptProvider;
}