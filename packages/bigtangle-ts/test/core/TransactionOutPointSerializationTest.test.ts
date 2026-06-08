import { describe, it } from 'vitest';
import { expect } from 'chai';
import { TransactionOutPoint } from '../../src/net/bigtangle/core/TransactionOutPoint';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { UtilBase } from './UtilBase';

describe('TransactionOutPointSerialization', () => {
    const PARAMS = MainNetParams.get();

    it('testTransactionOutPointSerialization', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678", "hex"));
        const outputIndex = 2;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        const serialized = outpoint.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(outputIndex);
    });

    it('testTransactionOutPointSerializationWithDifferentIndices', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("1a2b3c4d5e6f7890123456789012345678901234567890123456789012345678", "hex"));
        
        const indices = [0, 1, 100, 2147483647, 4294967295];
        
        for (const index of indices) {
            const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, index, blockHash, txHash);
            
            const serialized = outpoint.bitcoinSerialize();
            const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
            
            expect(deserializedOutpoint.getIndex()).to.equal(index);
            expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
            expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        }
    });

    it('testTransactionOutPointSerializationWithCoinbase', () => {
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, 4294967295, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH);
        
        expect(outpoint.isCoinBase()).to.be.true;
        
        const serialized = outpoint.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutpoint.isCoinBase()).to.be.true;
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(Sha256Hash.ZERO_HASH.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(Sha256Hash.ZERO_HASH.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(4294967295);
    });

    it('testTransactionOutPointSerializationRoundTrip', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba", "hex"));
        const outputIndex = 42;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        const serialized = outpoint.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(outputIndex);
        expect(deserializedOutpoint.getHash().getBuffer()).to.deep.equal(outpoint.getHash().getBuffer());
    });

    it('testTransactionOutPointSerializationWithConnectedOutput', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("1111111111111111111111111111111111111111111111111111111111111111", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("2222222222222222222222222222222222222222222222222222222222222222", "hex"));
        const outputIndex = 7;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        const transaction = new Transaction(PARAMS);
        const key = UtilBase.createTestKey();
        const address = key.toAddress(PARAMS);
        const coinValue = Coin.valueOf(100000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const connectedOutput = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        
        outpoint.connectedOutput = connectedOutput;
        
        const serialized = outpoint.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(outputIndex);
    });

    it('testTransactionOutPointSerializationWithZeroHashes', () => {
        const blockHash = Sha256Hash.ZERO_HASH;
        const txHash = Sha256Hash.ZERO_HASH;
        const outputIndex = 0;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        const serialized = outpoint.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(deserializedOutpoint.getBlockHash().getBuffer()).to.deep.equal(blockHash.getBuffer());
        expect(deserializedOutpoint.getTxHash().getBuffer()).to.deep.equal(txHash.getBuffer());
        expect(deserializedOutpoint.getIndex()).to.equal(outputIndex);
    });

    it('testTransactionOutPointGetConnectedOutput', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("3333333333333333333333333333333333333333333333333333333333333333", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("4444444444444444444444444444444444444444444444444444444444444444", "hex"));
        const outputIndex = 3;
        
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        expect(outpoint.getConnectedOutput()).to.be.null;
        
        const transaction = new Transaction(PARAMS);
        const key = UtilBase.createTestKey();
        const address = key.toAddress(PARAMS);
        const coinValue = Coin.valueOf(50000n, NetworkParameters.getBIGTANGLE_TOKENID());
        const connectedOutput = TransactionOutput.fromAddress(PARAMS, transaction, coinValue, address);
        
        outpoint.connectedOutput = connectedOutput;
        
        expect(outpoint.getConnectedOutput()).to.deep.equal(connectedOutput);
    });

    it('testTransactionOutPointEquality', () => {
        const blockHash = Sha256Hash.wrap(Buffer.from("5555555555555555555555555555555555555555555555555555555555555555", "hex"));
        const txHash = Sha256Hash.wrap(Buffer.from("6666666666666666666666666666666666666666666666666666666666666666", "hex"));
        const outputIndex = 5;
        
        const outpoint1 = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        const outpoint2 = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, outputIndex, blockHash, txHash);
        
        expect(outpoint1.equals(outpoint2)).to.be.true;
        expect(outpoint1.hashCode()).to.equal(outpoint2.hashCode());
        
        const serialized = outpoint1.bitcoinSerialize();
        const deserializedOutpoint = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());
        
        expect(outpoint1.equals(deserializedOutpoint)).to.be.true;
        expect(outpoint1.hashCode()).to.equal(deserializedOutpoint.hashCode());
    });
});
