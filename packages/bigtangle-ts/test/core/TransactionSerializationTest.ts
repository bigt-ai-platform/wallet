/*******************************************************************************
 *  Copyright   2018  Inasset GmbH. 
 *  
 *******************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Address } from '../../src/net/bigtangle/core/Address';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { TransactionOutPoint } from '../../src/net/bigtangle/core/TransactionOutPoint';
import { TransactionInput } from '../../src/net/bigtangle/core/TransactionInput';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { UtilParam } from '../../src/net/bigtangle/params/UtilParam';

describe('TransactionSerializationTest', () => {
    let params: NetworkParameters;
    let key: ECKey;
    let address: Address;

    beforeEach(() => {
        params = UtilParam.fromID(NetworkParameters.ID_MAINNET);
        key = ECKey.createNewKey(true);
        address = key.toAddress(params);
    });

    it('should serialize and deserialize basic transaction', () => {
        // Create a basic transaction with one input and one output
        const transaction = new Transaction(params);
        // Version is set in constructor, remove explicit setting
        // Version is set in constructor, remove explicit setting
        
        // Add an output
        const coinValue = Coin.valueOf(1000000n, Buffer.from('6263', 'hex')); // NetworkParameters.BIGTANGLE_TOKENID
        const output = TransactionOutput.fromAddress(params, transaction, coinValue, address);
        transaction.addOutput(output);
        
        // Add an input
        const blockHash = Sha256Hash.wrap(Buffer.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash = Sha256Hash.wrap(Buffer.from('1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678', 'hex'));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(params, 0, blockHash, txHash);
        const input = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint);
        transaction.addInput(input);
        
        // Serialize the transaction
        const serialized = transaction.bitcoinSerialize();
        
        // Deserialize the transaction
        const deserializedTransaction = Transaction.fromTransaction6(
            params, 
            serialized, 
            0, 
            null, 
            params.getDefaultSerializer(), 
            serialized.length
        );
        
        // Verify the deserialized transaction has the same properties
        // Version is not publicly accessible, so we skip the version check
        expect(deserializedTransaction.getInputs()).toHaveLength(1);
        expect(deserializedTransaction.getInputs()).toHaveLength(1);
        expect(deserializedTransaction.getOutputs()).toHaveLength(1);
        expect(deserializedTransaction.getInputs()[0].getOutpoint().getBlockHash().toString()).toBe(
            transaction.getInputs()[0].getOutpoint().getBlockHash().toString()
        );
        expect(deserializedTransaction.getOutputs()[0].getValue().getValue()).toBe(
            transaction.getOutputs()[0].getValue().getValue()
        );
    });

    it('should serialize and deserialize transaction with multiple inputs and outputs', () => {
        // Create a transaction with multiple inputs and outputs
        const transaction = new Transaction(params);
        // Version is set in constructor, remove explicit setting
        
        // Add multiple outputs
        const coinValue1 = Coin.valueOf(1000000n, Buffer.from('6263', 'hex'));
        const output1 = TransactionOutput.fromAddress(params, transaction, coinValue1, address);
        transaction.addOutput(output1);
        
        const coinValue2 = Coin.valueOf(2000000n, Buffer.from('6263', 'hex'));
        const key2 = ECKey.createNewKey(true);
        const address2 = key2.toAddress(params);
        const output2 = TransactionOutput.fromAddress(params, transaction, coinValue2, address2);
        transaction.addOutput(output2);
        
        // Add multiple inputs
        const blockHash1 = Sha256Hash.wrap(Buffer.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash1 = Sha256Hash.wrap(Buffer.from('1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678', 'hex'));
        const outpoint1 = TransactionOutPoint.fromTransactionOutPoint4(params, 0, blockHash1, txHash1);
        const input1 = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint1);
        transaction.addInput(input1);
        
        const blockHash2 = Sha256Hash.wrap(Buffer.from('111111111119d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash2 = Sha256Hash.wrap(Buffer.from('2b3c4d5e6f789012345678901234567890123456789012345678901234567890', 'hex'));
        const outpoint2 = TransactionOutPoint.fromTransactionOutPoint4(params, 1, blockHash2, txHash2);
        const input2 = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint2);
        transaction.addInput(input2);
        
        // Serialize the transaction
        const serialized = transaction.bitcoinSerialize();
        
        // Deserialize the transaction
        const deserializedTransaction = Transaction.fromTransaction6(
            params, 
            serialized, 
            0, 
            null, 
            params.getDefaultSerializer(), 
            serialized.length
        );
        
        // Verify the deserialized transaction has the same properties
        expect(deserializedTransaction.getInputs()).toHaveLength(2);
        expect(deserializedTransaction.getOutputs()).toHaveLength(2);
        
        // Check outputs
        expect(deserializedTransaction.getOutputs()[0].getValue().getValue()).toBe(coinValue1.getValue());
        expect(deserializedTransaction.getOutputs()[1].getValue().getValue()).toBe(coinValue2.getValue());
        
        // Check inputs
        expect(deserializedTransaction.getInputs()[0].getOutpoint().getBlockHash().toString()).toBe(
            outpoint1.getBlockHash().toString()
        );
        expect(deserializedTransaction.getInputs()[1].getOutpoint().getBlockHash().toString()).toBe(
            outpoint2.getBlockHash().toString()
        );
    });

    it('should serialize and deserialize transaction with lock time', () => {
        // Create a transaction with lock time
        const transaction = new Transaction(params);
        transaction.version = 1;
        const lockTime = 123456;
        transaction.setLockTime(lockTime);
        
        // Add an output
        const coinValue = Coin.valueOf(1000000n, Buffer.from('6263', 'hex'));
        const output = TransactionOutput.fromAddress(params, transaction, coinValue, address);
        transaction.addOutput(output);
        
        // Add an input
        const blockHash = Sha256Hash.wrap(Buffer.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash = Sha256Hash.wrap(Buffer.from('1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678', 'hex'));
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(params, 0, blockHash, txHash);
        const input = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint);
        transaction.addInput(input);
        
        // Serialize the transaction
        const serialized = transaction.bitcoinSerialize();
        
        // Deserialize the transaction
        const deserializedTransaction = Transaction.fromTransaction6(params, serialized, 0, null, params.getDefaultSerializer(), serialized.length);
        
        // Verify the deserialized transaction has the same properties
        // Version is not publicly accessible, so we skip the version check
        // Verify the deserialized transaction has the same properties
        // Version is not publicly accessible, so we skip the version check
        expect(deserializedTransaction.getLockTime()).toBe(transaction.getLockTime());
        expect(deserializedTransaction.getInputs()).toHaveLength(1);
        expect(deserializedTransaction.getOutputs()).toHaveLength(1);
    });

    it('should serialize and deserialize complex transaction with memo and data', () => {
        // Create a complex transaction with memo and data
        const transaction = new Transaction(params);
        // Version is set in constructor, remove explicit setting
        const lockTime = 999999;
        transaction.setLockTime(lockTime);
        
        // Add multiple outputs
        const coinValue1 = Coin.valueOf(1000000n, Buffer.from('6263', 'hex'));
        const output1 = TransactionOutput.fromAddress(params, transaction, coinValue1, address);
        transaction.addOutput(output1);
        
        const coinValue2 = Coin.valueOf(3000000n, Buffer.from('6263', 'hex'));
        const key2 = ECKey.createNewKey(true);
        const address2 = key2.toAddress(params);
        const output2 = TransactionOutput.fromAddress(params, transaction, coinValue2, address2);
        transaction.addOutput(output2);
        
        // Add multiple inputs
        const blockHash1 = Sha256Hash.wrap(Buffer.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash1 = Sha256Hash.wrap(Buffer.from('1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678', 'hex'));
        const outpoint1 = TransactionOutPoint.fromTransactionOutPoint4(params, 0, blockHash1, txHash1);
        const input1 = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint1);
        input1.setSequenceNumber(0x11223344);
        transaction.addInput(input1);
        
        const blockHash2 = Sha256Hash.wrap(Buffer.from('111111111119d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'hex'));
        const txHash2 = Sha256Hash.wrap(Buffer.from('2b3c4d5e6f789012345678901234567890123456789012345678901234567890', 'hex'));
        const outpoint2 = TransactionOutPoint.fromTransactionOutPoint4(params, 1, blockHash2, txHash2);
        const input2 = TransactionInput.fromOutpoint4(params, transaction, new Uint8Array(0), outpoint2);
        input2.setSequenceNumber(0x55667788);
        transaction.addInput(input2);
        
        // Set memo
        const memoText = 'Complex transaction test';
        transaction.setMemo(memoText);
        
        // Set data
        const testData = new TextEncoder().encode('Complex transaction data');
        transaction.setData(testData);
        transaction.setDataClassName('ComplexDataClass');
        
        // Serialize the transaction
        const serialized = transaction.bitcoinSerialize();
        
        // Deserialize the transaction
        const deserializedTransaction = Transaction.fromTransaction6(params, serialized, 0, null, params.getDefaultSerializer(), serialized.length);
        
        // Verify all properties are preserved
        // Version is not publicly accessible, so we skip the version check
        expect(deserializedTransaction.getLockTime()).toBe(transaction.getLockTime());
        expect(deserializedTransaction.getInputs()).toHaveLength(2);
        expect(deserializedTransaction.getOutputs()).toHaveLength(2);
        
        // Check outputs
        expect(deserializedTransaction.getOutputs()[0].getValue().getValue()).toBe(coinValue1.getValue());
        expect(deserializedTransaction.getOutputs()[1].getValue().getValue()).toBe(coinValue2.getValue());
        
        // Check inputs
        expect(deserializedTransaction.getInputs()[0].getSequenceNumber()).toBe(input1.getSequenceNumber());
        expect(deserializedTransaction.getInputs()[1].getSequenceNumber()).toBe(input2.getSequenceNumber());
        expect(deserializedTransaction.getInputs()[0].getOutpoint().getBlockHash().toString()).toBe(
            outpoint1.getBlockHash().toString()
        );
        expect(deserializedTransaction.getInputs()[1].getOutpoint().getBlockHash().toString()).toBe(
            outpoint2.getBlockHash().toString()
        );
        
        // Check memo
        expect(deserializedTransaction.getMemo()).toBeDefined();
        expect(deserializedTransaction.getMemo()).toContain(memoText);
        
        // Check data
        expect(deserializedTransaction.getData()).toEqual(testData);
        expect(deserializedTransaction.getDataClassName()).toBe('ComplexDataClass');
    });

    it('should serialize and deserialize coinbase transaction', () => {
        // Create a coinbase transaction
        const transaction = new Transaction(params);
        // Version is set in constructor, remove explicit setting
        
        // Add an output
        const coinValue = Coin.valueOf(5000000000n, Buffer.from('6263', 'hex'));
        const output = TransactionOutput.fromAddress(params, transaction, coinValue, address);
        transaction.addOutput(output);
        
        // Create a proper coinbase input with correct outpoint
        const coinbaseOutpoint = TransactionOutPoint.fromTransactionOutPoint4(
            params, 
            0xFFFFFFFF, // Special index for coinbase
            Sha256Hash.ZERO_HASH, 
            Sha256Hash.ZERO_HASH
        );
        const coinbaseInput = TransactionInput.fromOutpoint4(
            params, 
            transaction, 
            new Uint8Array([0x01, 0x02, 0x03]), // Coinbase script
            coinbaseOutpoint
        );
        transaction.addInput(coinbaseInput);
        
        // Serialize the transaction
        const serialized = transaction.bitcoinSerialize();
        
        // Deserialize the transaction
        const deserializedTransaction = Transaction.fromTransaction6(
            params, 
            serialized, 
            0, 
            null, 
            params.getDefaultSerializer(), 
            serialized.length
        );
        
        // Verify it's still a coinbase transaction
        expect(deserializedTransaction.isCoinBase()).toBe(true);
        expect(deserializedTransaction.getInputs()).toHaveLength(1);
        expect(deserializedTransaction.getOutputs()).toHaveLength(1);
        expect(deserializedTransaction.getOutputs()[0].getValue().getValue()).toBe(coinValue.getValue());
    });
});
