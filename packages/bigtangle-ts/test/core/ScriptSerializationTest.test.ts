import { describe, it, beforeEach } from 'vitest';
import { expect } from 'chai';
import { Script } from '../../src/net/bigtangle/script/Script';
import { ScriptBuilder } from '../../src/net/bigtangle/script/ScriptBuilder';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Address } from '../../src/net/bigtangle/core/Address';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import * as ScriptOpCodes from '../../src/net/bigtangle/script/ScriptOpCodes';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { TransactionInput } from '../../src/net/bigtangle/core/TransactionInput';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { TransactionSignature } from '../../src/net/bigtangle/crypto/TransactionSignature';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { UtilBase } from './UtilBase';
import { Coin } from '../../src/net/bigtangle/core/Coin';


describe('ScriptSerialization', () => {
    const PARAMS = MainNetParams.get();
    let key1: ECKey;
    let key2: ECKey;
    let key3: ECKey;

    beforeEach(() => {
        key1 = UtilBase.createTestKey();
        key2 = UtilBase.createTestKey();
        key3 = UtilBase.createTestKey();
    });

    it('testScriptSerializationWithPayToAddress', () => {
        const pubkeyHash = Utils.sha256hash160(key1.getPubKey());
        const address = new Address(PARAMS, PARAMS.getAddressHeader(), Buffer.from(pubkeyHash));
        const script = ScriptBuilder.createOutputScript(address);
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.isSentToAddress()).to.be.true;
        expect(deserializedScript.getPubKeyHash()).to.deep.equal(pubkeyHash);
    });

    it('testScriptSerializationWithPayToPubKey', () => {
        const script = ScriptBuilder.createOutputScript(key1);
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.isSentToRawPubKey()).to.be.true;
        expect(deserializedScript.getPubKey()).to.deep.equal(key1.getPubKey());
    });

    it('testScriptSerializationWithMultiSig', () => {
        const keys = [key1, key2, key3];
        const script = ScriptBuilder.createMultiSigOutputScript(2, keys);
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.isSentToMultiSig()).to.be.true;
        expect(deserializedScript.getNumberOfSignaturesRequiredToSpend()).to.equal(2);
        expect(deserializedScript.getPubKeys().length).to.equal(keys.length);
    });

    it('testScriptSerializationWithP2SH', () => {
        const scriptHash = Buffer.alloc(20, 0x01);
        const script = ScriptBuilder.createP2SHOutputScript(scriptHash);
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.isPayToScriptHash()).to.be.true;
        expect(deserializedScript.getPubKeyHash()).to.deep.equal(scriptHash);
    });

  
    it('testScriptSerializationWithEmptyScript', () => {
        const script = new ScriptBuilder().build();
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.equal(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.getChunks().length).to.equal(0);
    });

    it('testScriptSerializationWithComplexScript', () => {
        const script = new ScriptBuilder()
            .op(ScriptOpCodes.OP_DUP)
            .op(ScriptOpCodes.OP_HASH160)
            .data(Utils.sha256hash160(key1.getPubKey()))
            .op(ScriptOpCodes.OP_EQUALVERIFY)
            .op(ScriptOpCodes.OP_CHECKSIG)
            .build();
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.isSentToAddress()).to.be.true;
    });

    it('testScriptSerializationWithLargeData', () => {
        const largeData = Buffer.alloc(500, 0xAB);
        const script = new ScriptBuilder().data(largeData).build();
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.getChunks().length).to.equal(1);
        expect(deserializedScript.getChunks()[0].data).to.deep.equal(largeData);
    });

    it('testScriptSerializationWithMultipleChunks', () => {
        const script = new ScriptBuilder()
            .smallNum(1)
            .smallNum(2)
            .op(ScriptOpCodes.OP_ADD)
            .smallNum(3)
            .op(ScriptOpCodes.OP_EQUAL)
            .build();
        
        const serialized = script.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(script.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(script.getProgram());
        expect(deserializedScript.getChunks().length).to.equal(5);
    });

    it('testScriptSerializationRoundTrip', () => {
        const scripts = [
            ScriptBuilder.createOutputScript(new Address(PARAMS, PARAMS.getAddressHeader(), Buffer.from(Utils.sha256hash160(key1.getPubKey())))),
            ScriptBuilder.createOutputScript(key1),
            ScriptBuilder.createMultiSigOutputScript(2, [key1, key2, key3]),
            ScriptBuilder.createP2SHOutputScript(Buffer.alloc(20)),
            ScriptBuilder.createCLTVPaymentChannelOutput(BigInt(2000), key1, key2),
            new ScriptBuilder().op(ScriptOpCodes.OP_TRUE).build(),
            new ScriptBuilder().data(Buffer.from([0x01, 0x02, 0x03])).build()
        ];
        
        for (const originalScript of scripts) {
            const serialized = originalScript.getProgram();
            const deserializedScript = new Script(serialized);
            
            expect(deserializedScript.toString()).to.equal(originalScript.toString());
            expect(deserializedScript.getProgram()).to.deep.equal(originalScript.getProgram());
        }
    });

    it('testScriptChunksPreservation', () => {
        const originalScript = ScriptBuilder.createMultiSigOutputScript(2, [key1, key2]);
        const originalChunks = originalScript.getChunks();
        
        const serialized = originalScript.getProgram();
        const deserializedScript = new Script(serialized);
        const deserializedChunks = deserializedScript.getChunks();
        
        expect(deserializedChunks.length).to.equal(originalChunks.length);
        for (let i = 0; i < originalChunks.length; i++) {
            const originalChunk = originalChunks[i];
            const deserializedChunk = deserializedChunks[i];
            
            expect(deserializedChunk.opcode).to.equal(originalChunk.opcode);
            if (originalChunk.data) {
                expect(deserializedChunk.data).to.deep.equal(originalChunk.data);
            } else {
                expect(deserializedChunk.data).to.be.null;
            }
        }
    });

    it('testScriptWithSignatures', async () => {
        const tx = new Transaction(PARAMS);
        const outputScript = ScriptBuilder.createOutputScript(key1);
        const output = TransactionOutput.fromCoinKey(
            PARAMS, 
            tx, 
            Coin.valueOf(1000000n, NetworkParameters.getBIGTANGLE_TOKENID()), 
            key1
        );
        tx.addOutput(output);
        
        const input = TransactionInput.fromScriptBytes(PARAMS, tx, Buffer.alloc(0));
        tx.addInput(input);
        
        const sighash = tx.hashForSignature(0, outputScript.getProgram(), 1, false);
        const ecdsaSignature = await key1.sign(sighash.getBytes());
        const r = BigInt(ecdsaSignature.r.toString());
        const s = BigInt(ecdsaSignature.s.toString());
        const signature = new TransactionSignature(r, s, 1);
        
        const inputScript = ScriptBuilder.createInputScript(signature, key1);
        
        const serialized = inputScript.getProgram();
        expect(serialized).to.not.be.null;
        expect(serialized.length).to.be.greaterThan(0);
        
        const deserializedScript = new Script(serialized);
        
        expect(deserializedScript.toString()).to.equal(inputScript.toString());
        expect(deserializedScript.getProgram()).to.deep.equal(inputScript.getProgram());
    });
});
