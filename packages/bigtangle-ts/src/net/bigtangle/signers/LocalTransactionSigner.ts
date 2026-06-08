import { StatelessTransactionSigner } from './StatelessTransactionSigner';
import { Transaction } from '../core/Transaction';
import { ECKey } from '../core/ECKey';
import { Script } from '../script/Script';
import { KeyBag } from '../wallet/KeyBag'; // Placeholder
import { MissingPrivateKeyException } from '../crypto/MissingPrivateKeyException';
// Placeholder
import { DeterministicKey } from '../crypto/DeterministicKey';
import { SigHash } from '../core/SigHash';
import { ScriptBuilder } from '../script/ScriptBuilder';

/**
 * <p>{@link TransactionSigner} implementation for signing inputs using keys from provided {@link net.bigtangle.wallet.KeyBag}.</p>
 * <p>This signer doesn't create input scripts for tx inputs. Instead it expects inputs to contain scripts with
 * empty sigs and replaces one of the empty sigs with calculated signature.
 * </p>
 * <p>This signer is always implicitly added into every wallet and it is the first signer to be executed during tx
 * completion. As the first signer to create a signature, it stores derivation path of the signing key in a given
 * {@link ProposedTransaction} object that will be also passed then to the next signer in chain. This allows other
 * signers to use correct signing key for P2SH inputs, because all the keys involved in a single P2SH address have
 * the same derivation path.</p>
 * <p>This signer always uses {@link net.bigtangle.core.Transaction.SigHash#ALL} signing mode.</p>
 */
export class LocalTransactionSigner extends StatelessTransactionSigner {

    private static readonly MINIMUM_VERIFY_FLAGS = new Set<Script.VerifyFlag>([
        Script.VerifyFlag.P2SH,
        Script.VerifyFlag.NULLDUMMY,
    ]);

    public isReady(): boolean {
        return true;
    }

    public async signInputs(propTx: any, keyBag: KeyBag): Promise<boolean> {
        const tx: Transaction = propTx.partialTx;
        const numInputs = tx.getInputs().length;
        for (let i = 0; i < numInputs; i++) {
            const txIn = tx.getInput(i);
            if (txIn.getConnectedOutput() === null) {
                console.warn(`Missing connected output, assuming input ${i} is already signed.`);
                continue;
            }

            // Only skip signing if the scriptSig is already fully populated with both signature and public key
            // For P2PKH transactions, scriptSig should have 2 elements: signature and public key
            // For P2PK transactions, scriptSig should have 1 element: signature
            const currentScriptSig = txIn.getScriptSig();
            if (currentScriptSig.getChunks().length > 0) {
                const connectedOutput = txIn.getConnectedOutput()!;
                const currentScriptPubKey = connectedOutput.getScriptPubKey();

                // Check if it's a P2PK output (pubkey OP_CHECKSIG)
                if (currentScriptPubKey.isSentToRawPubKey()) {
                    // For P2PK outputs, scriptSig should have exactly 1 element (signature)
                    if (currentScriptSig.getChunks().length === 1) {
                        try {
                            txIn.getScriptSig().correctlySpends(tx, i, txIn.getConnectedOutput()!.getScriptPubKey(), LocalTransactionSigner.MINIMUM_VERIFY_FLAGS);
                            console.warn(`Input ${i} already correctly spends output, assuming SIGHASH type used will be safe and skipping signing.`);
                            continue;
                        } catch {
                            // Expected - proceed with signing
                        }
                    }
                } else {
                    // For P2PKH outputs (OP_DUP OP_HASH160 pubKeyHash OP_EQUALVERIFY OP_CHECKSIG),
                    // scriptSig should have exactly 2 elements (signature, pubkey)
                    if (currentScriptSig.getChunks().length === 2) {
                        try {
                            txIn.getScriptSig().correctlySpends(tx, i, txIn.getConnectedOutput()!.getScriptPubKey(), LocalTransactionSigner.MINIMUM_VERIFY_FLAGS);
                            console.warn(`Input ${i} already correctly spends output, assuming SIGHASH type used will be safe and skipping signing.`);
                            continue;
                        } catch {
                            // Expected - proceed with signing
                        }
                    }
                }
            }

            const redeemData = await txIn.getConnectedRedeemData(keyBag);
            if (redeemData === null) {
                continue;
            }
            const scriptPubKey = txIn.getConnectedOutput()!.getScriptPubKey();

            // For P2SH inputs we need to share derivation path of the signing key with other signers, so that they
            // use correct key to calculate their signatures.
            // Married keys all have the same derivation path, so we can safely just take first one here.
            const pubKey: ECKey = redeemData.keys[0];
            if (pubKey instanceof DeterministicKey) {
                propTx.keyPaths.set(scriptPubKey, (pubKey as DeterministicKey).getPath());
            }

            let key: ECKey | null;
            // locate private key in redeem data. For pay-to-address and pay-to-key inputs RedeemData will always contain
            // only one key (with private bytes). For P2SH inputs RedeemData will contain multiple keys, one of which MAY
            // have private bytes
            if ((key = redeemData.getFullKey()) === null) {
                console.warn(`No local key found for input ${i}`);
                continue;
            }
           let inputScript = txIn.getScriptSig();
            const connectedOutput = txIn.getConnectedOutput()!;
            const currentScriptPubKey = connectedOutput.getScriptPubKey();
            try {
                const signature = await tx.calculateSignature(i, key, currentScriptPubKey.getProgram(),  SigHash.ALL, false);
                 // For P2PK outputs (scriptPubKey is PUSHDATA(pubkey) OP_CHECKSIG),
                 // the scriptSig should only contain the signature, not signature + public key
                 if (currentScriptPubKey.isSentToRawPubKey()) {
                     // For raw public key outputs, only push the signature

                     const newInputScript = ScriptBuilder.createInputScript(signature, undefined);
                     txIn.setScriptSig(newInputScript);

                 } else {
                     // For P2PKH outputs (scriptPubKey is OP_DUP OP_HASH160 PUSHDATA(pubKeyHash) OP_EQUALVERIFY OP_CHECKSIG),
                     // the scriptSig should contain the signature and public key
                     // Also for other script types that require both signature and public key

                     const newInputScript = ScriptBuilder.createInputScript(signature, key);
                     txIn.setScriptSig(newInputScript);

                 }
            } catch (e: any) {
                if (e instanceof MissingPrivateKeyException) {
                    console.warn(`No private key in keypair for input ${i}`);
                } else {
                    // For other errors, rethrow after logging
                    console.error(`Error signing input ${i}:`, e);
                    throw e;
                }
            }
        }
        return true;
    }
}
