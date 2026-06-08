import { describe, it, beforeEach } from 'vitest';
import { expect } from 'chai';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Address } from '../../src/net/bigtangle/core/Address';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { TransactionInput } from '../../src/net/bigtangle/core/TransactionInput';
import { TransactionOutPoint } from '../../src/net/bigtangle/core/TransactionOutPoint';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { UtilBase } from './UtilBase';

describe('TransactionInputSerialization', () => {
    const PARAMS = MainNetParams.get();
    let transaction: Transaction;
    let key: ECKey;
    let address: Address;

    beforeEach(() => {
        transaction = new Transaction(PARAMS);
        key = UtilBase.createTestKey();
        address = key.toAddress(PARAMS);
    });

    it('testTransactionInputSerializationWithCoin', () => {
        const coinValue = Coin.valueOf(1000000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        // Set the outpoint
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        inputObj.scriptBytes = Buffer.alloc(0);
        inputObj.sequence = 0xffffffff;
        inputObj.value = coinValue;
        
        expect(input.getValue()?.value).to.equal(coinValue.value);
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getOutpoint().getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedInput.getOutpoint().getTxHash().getBuffer()).to.deep.equal(output.getParentTransactionHash().getBuffer());
        expect(deserializedInput.getOutpoint().getIndex()).to.equal(output.getIndex());
    });

    it('testTransactionInputSerializationWithDifferentCoinValues', () => {
        const values = [1n, 1000n, 1000000n, BigInt(Number.MAX_SAFE_INTEGER)];
        
        for (const value of values) {
            transaction = new Transaction(PARAMS);
            const coinValue = Coin.valueOf(value, NetworkParameters.getBIGTANGLE_TOKENID());
            const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
            transaction.addOutput(output);
            
            const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
            const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
            const input = new TransactionInput(PARAMS);
            input.setParent(transaction);
            // Set the outpoint
            const inputObj = input as any;
            inputObj.outpoint = outpoint;
            inputObj.scriptBytes = Buffer.alloc(0);
            inputObj.sequence = 0xffffffff;
            inputObj.value = coinValue;
            
            const serialized = input.bitcoinSerialize();
            const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
            
            // Verify the outpoint is preserved
            expect(deserializedInput.getOutpoint().getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
            expect(deserializedInput.getOutpoint().getTxHash().getBuffer()).to.deep.equal(output.getParentTransactionHash().getBuffer());
            expect(deserializedInput.getOutpoint().getIndex()).to.equal(output.getIndex());
        }
    });

    it('testTransactionInputSerializationWithScript', () => {
        const coinValue = Coin.valueOf(500000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        // Set the outpoint
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        inputObj.scriptBytes = Buffer.alloc(0);
        inputObj.sequence = 0xffffffff;
        
        const scriptData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        input.setScriptBytes(scriptData);
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getScriptBytes()).to.deep.equal(scriptData);
    });

    it('testTransactionInputSerializationWithSequenceNumber', () => {
        const coinValue = Coin.valueOf(250000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        // Set the outpoint
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        inputObj.scriptBytes = Buffer.alloc(0);
        inputObj.sequence = 0xffffffff;
        
        const sequenceNumber = 0x12345678;
        input.setSequenceNumber(sequenceNumber);
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getSequenceNumber()).to.equal(sequenceNumber);
    });

    it('testTransactionInputSerializationWithOutpoint', () => {
        const coinValue = Coin.valueOf(123456n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678", "hex"));
        const outputIndex = 2;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        const scriptBytes = Buffer.alloc(0);
        const input = TransactionInput.fromOutpoint5(PARAMS, transaction, scriptBytes, outpoint, coinValue);
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        const deserializedOutpoint = deserializedInput.getOutpoint();
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(outputIndex);
    });

    it('testTransactionInputSerializationRoundTrip', () => {
        const coinValue = Coin.valueOf(999999n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        // Set the outpoint
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        inputObj.scriptBytes = Buffer.alloc(0);
        inputObj.sequence = 0xffffffff;
        
        input.setSequenceNumber(0x11223344);
        const scriptData = Buffer.from([0x05, 0x06, 0x07, 0x08, 0x09, 0x0A]);
        input.setScriptBytes(scriptData);
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getSequenceNumber()).to.equal(0x11223344);
        expect(deserializedInput.getScriptBytes()).to.deep.equal(scriptData);
        expect(deserializedInput.getOutpoint().getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
    });

    it('testTransactionInputSerializationWithEmptyScript', () => {
        const coinValue = Coin.valueOf(555555n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, output.getIndex(), blockHash, output.getParentTransactionHash());
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        // Set the outpoint
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        inputObj.scriptBytes = Buffer.alloc(0);
        inputObj.sequence = 0xffffffff;
        input.setScriptBytes(Buffer.alloc(0));
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getScriptBytes().length).to.equal(0);
    });

    it('testTransactionInputSerializationWithNullValue', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678", "hex"));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, 1, blockHash, txHash);
        
        const scriptBytes = Buffer.from([0x01, 0x02]);
        const input = new TransactionInput(PARAMS);
        input.setParent(transaction);
        input.setScriptBytes(scriptBytes);
        // Set the outpoint manually
        const inputObj = input as any;
        inputObj.outpoint = outpoint;
        
        const serialized = input.bitcoinSerialize();
        const deserializedInput = TransactionInput.fromTransactionInput5(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedInput.getOutpoint().getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedInput.getOutpoint().getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedInput.getScriptBytes()).to.deep.equal(scriptBytes);
    });
});
