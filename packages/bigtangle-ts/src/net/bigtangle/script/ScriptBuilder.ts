import { ScriptChunk } from './ScriptChunk';
// Type-only import to avoid circular dependency during module initialization
import type { Script } from './Script';
import { Address } from '../core/Address';
import { ECKey } from '../core/ECKey';
import { Utils } from '../utils/Utils';
import { TransactionSignature } from '../crypto/TransactionSignature';
import * as ScriptOpCodes from './ScriptOpCodes';
import { encodeToOpN } from './ScriptOpCodes';

// Lazy-loaded Script class reference - loaded on first use via getter
let _ScriptClass: typeof Script | null = null;

/**
 * Get the Script class, initializing it on first use.
 * The key insight is that by the time any code calls build(),
 * all module initialization is complete, so we can safely access Script.
 */
function getScriptClass(): typeof Script {
  if (_ScriptClass === null) {
    // This is a "trick" - we use Function constructor to do a dynamic require
    // that works in both ESM and CJS environments
    // The import happens at runtime AFTER all static initialization is complete
    try {
      // For bundlers/webpack - they will transform this properly
      _ScriptClass = (globalThis as any).__SCRIPT_CLASS__;
      if (!_ScriptClass) {
        throw new Error('Script not registered');
      }
    } catch {
      throw new Error(
        'Script class not available. Make sure to import Script before using ScriptBuilder. ' +
        'Either import from the main index.ts or import Script directly before using ScriptBuilder.'
      );
    }
  }
  return _ScriptClass;
}

/**
 * Register the Script class globally. This is called by index.ts
 */
export function registerScriptForBuilder(scriptClass: typeof Script): void {
  _ScriptClass = scriptClass;
  (globalThis as any).__SCRIPT_CLASS__ = scriptClass;
}

export class ScriptBuilder {
    private chunks: ScriptChunk[];

    constructor(template?: Script) {
        this.chunks = template ? [...template.getChunks()] : [];
    }

    addChunk(chunk: ScriptChunk): ScriptBuilder {
        this.chunks.push(chunk);
        return this;
    }

    op(opcode: number): ScriptBuilder {
        if (opcode <= ScriptOpCodes.OP_PUSHDATA4) {
            throw new Error("Opcode must be greater than OP_PUSHDATA4 for direct opcode addition.");
        }
        return this.addChunk(new ScriptChunk(opcode, null));
    }

    data(data: Uint8Array): ScriptBuilder {
        if (!data) {
            return this.smallNum(0);
        }
        if (data.length === 0) {
            return this.smallNum(0);
        } else {
            return this.addDataChunk(data);
        }
    }

    private addDataChunk(data: Uint8Array): ScriptBuilder {
        let opcode: number;
        if (data.length === 0) {
            opcode = ScriptOpCodes.OP_0;
        } else if (data.length === 1) {
            const b = data[0];
            if (b >= 1 && b <= 16) {
                opcode = encodeToOpN(b);
            } else {
                opcode = 1;
            }
        } else if (data.length < ScriptOpCodes.OP_PUSHDATA1) {
            opcode = data.length;
        } else if (data.length < 256) {
            opcode = ScriptOpCodes.OP_PUSHDATA1;
        } else if (data.length < 65536) {
            opcode = ScriptOpCodes.OP_PUSHDATA2;
        } else {
            throw new Error("Unimplemented: Data length too large for PUSHDATA opcodes.");
        }
        return this.addChunk(new ScriptChunk(opcode, new Uint8Array(data)));
    }

    number(num: number | bigint ): ScriptBuilder {
        if (typeof num === 'number' && num >= 0 && num <= 16) {
            return this.smallNum(num);
        } else {
            return this.bigNum(num);
        }
    }

    smallNum(num: number): ScriptBuilder {
        if (num < 0 || num > 16) {
            throw new Error("Cannot encode numbers outside 0-16 with smallNum");
        }
        return this.addChunk(new ScriptChunk(encodeToOpN(num), null));
    }

    protected bigNum(num: number | bigint): ScriptBuilder {
        let data: Uint8Array;

        if (typeof num === 'number' && num === 0) {
            data = new Uint8Array(0);
        } else {
            let absValue: bigint;
            let neg = false;
            if (typeof num === 'number') {
                neg = num < 0;
                absValue = BigInt(Math.abs(num));
            } else { // bigInt.BigInteger
                neg = num < 0n;
                absValue = num < 0n ? -num : num;
            }

            const result: number[] = [];
            while (absValue !== 0n) {
                result.push(Number(absValue & 0xffn));
                absValue = absValue >> 8n;
            }

            if ((result[result.length - 1] & 0x80) !== 0) {
                result.push(neg ? 0x80 : 0x00);
            } else if (neg) {
                result[result.length - 1] |= 0x80;
            }
            data = new Uint8Array(result);
        }
        return this.addChunk(new ScriptChunk(data.length, data));
    }

    build(): Script {
        const ScriptClass = getScriptClass();
        return new ScriptClass(this.chunks);
    }

    static createOutputScript(to: Address | ECKey): Script {
        if (to instanceof Address) {
            if (to.isP2SHAddress()) {
                return new ScriptBuilder()
                    .op(ScriptOpCodes.OP_HASH160)
                    .data(to.getHash160())
                    .op(ScriptOpCodes.OP_EQUAL)
                    .build();
            } else {
                return new ScriptBuilder()
                    .op(ScriptOpCodes.OP_DUP)
                    .op(ScriptOpCodes.OP_HASH160)
                    .data(to.getHash160())
                    .op(ScriptOpCodes.OP_EQUALVERIFY)
                    .op(ScriptOpCodes.OP_CHECKSIG)
                    .build();
            }
        } else if (to instanceof ECKey) {
            return new ScriptBuilder().data(to.getPubKey()).op(ScriptOpCodes.OP_CHECKSIG).build();
        }
        throw new Error("Invalid type for createOutputScript");
    }

    static createInputScript(signature: TransactionSignature | null, pubKey?: ECKey): Script {
        const sigBytes = signature !== null ? signature.encodeToBitcoin() : new Uint8Array();
        const builder = new ScriptBuilder().data(sigBytes);
        if (pubKey) {
            builder.data(pubKey.getPubKey());
        }
        return builder.build();
    }

    static createMultiSigOutputScript(threshold: number, pubkeys: ECKey[]): Script {
        if (threshold <= 0 || threshold > pubkeys.length || pubkeys.length > 16) {
            throw new Error("Invalid threshold or number of public keys for multisig.");
        }
        const builder = new ScriptBuilder();
        builder.smallNum(threshold);
        // Use the order as given (do not sort)
        for (const key of pubkeys) {
            builder.data(key.getPubKey());
        }
        builder.smallNum(pubkeys.length);
        builder.op(ScriptOpCodes.OP_CHECKMULTISIG);
        return builder.build();
    }

    static createMultiSigInputScript(signatures: TransactionSignature[] | Uint8Array[], multisigProgramBytes?: Uint8Array): Script {
        const builder = new ScriptBuilder();
        builder.smallNum(0); // Work around a bug in CHECKMULTISIG
        for (const sig of signatures) {
            if (sig instanceof Uint8Array) {
                builder.data(sig);
            } else {
                builder.data(sig.encodeToBitcoin());
            }
        }
        if (multisigProgramBytes) {
            builder.data(multisigProgramBytes);
        }
        return builder.build();
    }

    static createP2SHMultiSigInputScript(signatures: TransactionSignature[] | null, multisigProgram: Script): Script {
        const sigs: Uint8Array[] = [];
        if (signatures === null) {
            const numSigs = multisigProgram.getNumberOfSignaturesRequiredToSpend();
            for (let i = 0; i < numSigs; i++) {
                sigs.push(new Uint8Array()); // Empty signature placeholder
            }
        } else {
            for (const signature of signatures) {
                sigs.push(signature.encodeToBitcoin());
            }
        }
        return ScriptBuilder.createMultiSigInputScript(sigs, multisigProgram.getProgram());
    }

    static updateScriptWithSignature(scriptSig: Script, signature: Uint8Array, targetIndex: number, sigsPrefixCount: number, sigsSuffixCount: number): Script {
        const builder = new ScriptBuilder();
        const inputChunks = scriptSig.getChunks();
        const totalChunks = inputChunks.length;

        // Handle prefix chunks
        for (let i = 0; i < sigsPrefixCount && i < totalChunks; i++) {
            builder.addChunk(inputChunks[i]);
        }

        let pos = 0;
        let inserted = false;
        const signatureInsertionStart = Math.min(sigsPrefixCount, totalChunks);
        const signatureInsertionEnd = Math.min(totalChunks, Math.max(signatureInsertionStart, totalChunks - sigsSuffixCount));
        
        for (let i = signatureInsertionStart; i < signatureInsertionEnd; i++) {
            const chunk = inputChunks[i];
            if (pos === targetIndex) {
                // Check if we're trying to replace a non-placeholder signature
                if (chunk.data && chunk.data.length > 0) {
                    throw new Error("Cannot update a non-placeholder signature");
                }
                inserted = true;
                builder.data(signature);
                pos++;
            }
            // Skip placeholder OP_0 chunks
            if (chunk && !chunk.equalsOpCode(ScriptOpCodes.OP_0)) {
                builder.addChunk(chunk);
                pos++;
            }
        }

        // Add the signature if we haven't inserted it yet
        if (!inserted) {
            // We might be in a situation where we need to add a new signature slot
            if (targetIndex >= pos) {
                // Add placeholders until we reach the target index
                while (pos < targetIndex) {
                    builder.addChunk(new ScriptChunk(ScriptOpCodes.OP_0, null));
                    pos++;
                }
                builder.data(signature);
                inserted = true;
                pos++;
            }
        }

        // Add any remaining placeholders
        while (pos < totalChunks - sigsPrefixCount - sigsSuffixCount) {
            builder.addChunk(new ScriptChunk(ScriptOpCodes.OP_0, null));
            pos++;
        }

        // Handle suffix chunks
        for (let i = totalChunks - sigsSuffixCount; i < totalChunks; i++) {
            if (i >= 0 && i < totalChunks) {
                builder.addChunk(inputChunks[i]);
            }
        }

        if (!inserted) {
            throw new Error("Signature not inserted. This should not happen.");
        }
        return builder.build();
    }

    static createP2SHOutputScript(hash: Uint8Array): Script {
        if (hash.length !== 20) {
            throw new Error("Hash must be 20 bytes long for P2SH output script.");
        }
        return new ScriptBuilder().op(ScriptOpCodes.OP_HASH160).data(hash).op(ScriptOpCodes.OP_EQUAL).build();
    }

    static createP2SHOutputScriptFromScript(redeemScript: Script): Script {
        const hash = Utils.sha256hash160(redeemScript.getProgram());
        return ScriptBuilder.createP2SHOutputScript(hash);
    }

    static createP2SHOutputScriptWithKeys(threshold: number, pubkeys: ECKey[]): Script {
        const redeemScript = ScriptBuilder.createRedeemScript(threshold, pubkeys);
        return ScriptBuilder.createP2SHOutputScriptFromScript(redeemScript);
    }

    static createRedeemScript(threshold: number, pubkeys: ECKey[]): Script {
        const sortedPubkeys = [...pubkeys].sort((a, b) => {
            const pubA = a.getPubKey();
            const pubB = b.getPubKey();
            for (let i = 0; i < Math.min(pubA.length, pubB.length); i++) {
                if (pubA[i] !== pubB[i]) {
                    return pubA[i] - pubB[i];
                }
            }
            return pubA.length - pubB.length;
        });
        return ScriptBuilder.createMultiSigOutputScript(threshold, sortedPubkeys);
    }

    static createOpReturnScript(data: Uint8Array): Script {
        if (data.length > 80) {
            throw new Error("Data too long for OP_RETURN script (max 80 bytes).");
        }
        return new ScriptBuilder().op(ScriptOpCodes.OP_RETURN).data(data).build();
    }

    static createCLTVPaymentChannelOutput(time: bigint, from: ECKey, to: ECKey): Script {
        const timeBytes = Utils.encodeMPI(time, false);
        if (timeBytes.length > 5) {
            throw new Error("Time too large to encode as 5-byte int");
        }
        return new ScriptBuilder().op(ScriptOpCodes.OP_IF)
            .data(to.getPubKey()).op(ScriptOpCodes.OP_CHECKSIGVERIFY) // Assuming OP_CHECKSIGVERIFY exists
            .op(ScriptOpCodes.OP_ELSE)
            .data(timeBytes).op(ScriptOpCodes.OP_CHECKLOCKTIMEVERIFY).op(ScriptOpCodes.OP_DROP)
            .op(ScriptOpCodes.OP_ENDIF)
            .data(from.getPubKey()).op(ScriptOpCodes.OP_CHECKSIG).build();
    }

    static createCLTVPaymentChannelRefund(signature: TransactionSignature): Script {
        const builder = new ScriptBuilder();
        builder.data(signature.encodeToBitcoin());
        builder.data(new Uint8Array([0])); // Use the CHECKLOCKTIMEVERIFY if branch
        return builder.build();
    }

    static createCLTVPaymentChannelP2SHRefund(signature: TransactionSignature, redeemScript: Script): Script {
        const builder = new ScriptBuilder();
        builder.data(signature.encodeToBitcoin());
        builder.data(new Uint8Array([0])); // Use the CHECKLOCKTIMEVERIFY if branch
        builder.data(redeemScript.getProgram());
        return builder.build();
    }

    static createCLTVPaymentChannelP2SHInput(from: Uint8Array, to: Uint8Array, redeemScript: Script): Script {
        const builder = new ScriptBuilder();
        builder.data(from);
        builder.data(to);
        builder.smallNum(1); // Use the CHECKLOCKTIMEVERIFY if branch
        builder.data(redeemScript.getProgram());
        return builder.build();
    }

    static createCLTVPaymentChannelInput(from: TransactionSignature | Uint8Array, to: TransactionSignature | Uint8Array): Script {
        const fromBytes = from instanceof TransactionSignature ? from.encodeToBitcoin() : from;
        const toBytes = to instanceof TransactionSignature ? to.encodeToBitcoin() : to;
        const builder = new ScriptBuilder();
        builder.data(fromBytes);
        builder.data(toBytes);
        builder.smallNum(1); // Use the CHECKLOCKTIMEVERIFY if branch
        return builder.build();
    }
}
