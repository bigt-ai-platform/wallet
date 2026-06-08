import { describe, it, beforeEach } from 'vitest';
import { expect } from 'chai';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Address } from '../../src/net/bigtangle/core/Address';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { UtilBase } from './UtilBase';

describe('TransactionOutputSerialization', () => {
    const PARAMS = MainNetParams.get();
    let transaction: Transaction;
    let key: ECKey;
    let address: Address;

    beforeEach(() => {
        transaction = new Transaction(PARAMS);
        key = UtilBase.createTestKey();
        address = key.toAddress(PARAMS);
    });

    it('testTransactionOutputSerializationWithCoin', () => {
        const coinValue = Coin.valueOf(1000000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        expect(output.getValue()).to.deep.equal(coinValue);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
    });

    it('testTransactionOutputSerializationWithDifferentCoinValues', () => {
        const values = [1n, 1000n, 1000000n, BigInt(Number.MAX_SAFE_INTEGER)];
        
        for (const value of values) {
            const coinValue = Coin.valueOf(value, NetworkParameters.getBIGTANGLE_TOKENID());
            const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
            transaction.addOutput(output);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
            
            expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
        }
    });

    it('testTransactionOutputSerializationWithScript', () => {
        const coinValue = Coin.valueOf(500000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const scriptBytes = output.getScriptBytes();
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getScriptBytes()).to.deep.equal(scriptBytes);
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
    });

    it('testTransactionOutputSerializationWithPublicKey', () => {
        const coinValue = Coin.valueOf(250000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromCoinKey(PARAMS, transaction, coinValue, key);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
        expect(deserializedOutput.getScriptBytes()).to.not.be.null;
    });

    it('testTransactionOutputSerializationRoundTrip', () => {
        const coinValue = Coin.valueOf(999999n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
        expect(deserializedOutput.getScriptBytes()).to.deep.equal(output.getScriptBytes());
    });

    it('testTransactionOutputSerializationWithZeroValue', () => {
        const coinValue = Coin.valueOf(0n, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
        expect(deserializedOutput.getValue().value).to.equal(0n);
    });

    it('testTransactionOutputSerializationWithDifferentTokenIds', () => {
        const tokenIds = [
            NetworkParameters.getBIGTANGLE_TOKENID(),
            Buffer.from("0000000000000000000000000000000000000000000000000000000000000001", "hex"),
            Buffer.from("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "hex")
        ];
        
        for (const tokenId of tokenIds) {
            const coinValue = Coin.valueOf(123456n, tokenId);
            const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
            transaction.addOutput(output);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
            
            expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
            expect(deserializedOutput.getValue().tokenid).to.deep.equal(tokenId);
        }
    });

    it('testTransactionOutputSerializationWithLargeValue', () => {
        const largeValue = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
        const coinValue = new Coin(largeValue, NetworkParameters.getBIGTANGLE_TOKENID());
        const output = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        transaction.addOutput(output);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(PARAMS, transaction, serialized, 0, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutput.getValue()).to.deep.equal(coinValue);
        expect(deserializedOutput.getValue().value).to.equal(largeValue);
    });
});
