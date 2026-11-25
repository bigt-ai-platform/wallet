import { ScriptChunk } from './ScriptChunk.js';
import {
    OP_DUP, OP_HASH160, OP_EQUALVERIFY, OP_CHECKSIG
} from './ScriptOpCodes.js';

/**
 * Module containing standard script chunks to avoid circular dependency initialization issues.
 */
export class StandardScriptChunks {
    private static _standardTransactionScriptChunks: ScriptChunk[] | null = null;

    /**
     * Lazy initialization of standard transaction script chunks to avoid circular dependency issues during module loading.
     */
    static get STANDARD_TRANSACTION_SCRIPT_CHUNKS(): ScriptChunk[] {
        if (this._standardTransactionScriptChunks === null) {
            this._standardTransactionScriptChunks = [
                new ScriptChunk(OP_DUP, null, 0),
                new ScriptChunk(OP_HASH160, null, 1),
                new ScriptChunk(OP_EQUALVERIFY, null, 23),
                new ScriptChunk(OP_CHECKSIG, null, 24),
            ];
        }
        return this._standardTransactionScriptChunks;
    }
}