import { describe, it } from 'vitest';
import { expect } from 'chai';
import { Coin } from '../../src/net/bigt-ai/core/Coin';
import { CoinConstants } from '../../src/net/bigt-ai/core/CoinConstants';
import { Transaction } from '../../src/net/bigt-ai/core/Transaction';
import { TransactionOutput } from '../../src/net/bigt-ai/core/TransactionOutput';
import { Address } from '../../src/net/bigt-ai/core/Address';
import { NetworkParameters } from '../../src/net/bigt-ai/params/NetworkParameters';
import { MainNetParams } from '../../src/net/bigt-ai/params/MainNetParams';
import { UtilBase } from './UtilBase';


let cachedAddress: Address | null = null;

function getTestAddress(): Address {
    if (!cachedAddress) {
        cachedAddress = Address.fromKey(MainNetParams.get(), UtilBase.createTestKey());
    }
    return cachedAddress;
}

describe('CoinSerialization', () => {
    it('testCoinSerializationWithStandardValues', () => {
        const values = [0n, 1n, 1000n, 1000000n, CoinConstants.COIN.value, BigInt(Number.MAX_SAFE_INTEGER)];
        const address = getTestAddress();
        
        for (const value of values) {
            const coin = Coin.valueOf(value, NetworkParameters.getBIGT_AI_TOKENID());
            
            const transaction = new Transaction(MainNetParams.get());
            const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(
                MainNetParams.get(), 
                transaction, 
                serialized, 
                0, 
                MainNetParams.get().getDefaultSerializer()
            );
            const deserializedCoin = deserializedOutput.getValue();
            
            expect(deserializedCoin).to.deep.equal(coin);
            expect(deserializedCoin.value).to.equal(coin.value);
            expect(deserializedCoin.tokenid).to.deep.equal(coin.tokenid);
        }
    });

    it('testCoinSerializationWithDifferentTokenIds', () => {
        const value = 123456n;
        
        const tokenIds = [
            NetworkParameters.getBIGT_AI_TOKENID(),
            Buffer.from("0000000000000000000000000000000000000000000000000000000000000001", "hex"),
            Buffer.from("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "hex")
        ];
        
        for (const tokenId of tokenIds) {
            const coin = Coin.valueOf(value, tokenId);
            
            const transaction = new Transaction(MainNetParams.get());
            const address = getTestAddress();
            const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(
                MainNetParams.get(), 
                transaction, 
                serialized, 
                0, 
                MainNetParams.get().getDefaultSerializer()
            );
            const deserializedCoin = deserializedOutput.getValue();
            
            expect(deserializedCoin).to.deep.equal(coin);
            expect(deserializedCoin.value).to.equal(coin.value);
            expect(deserializedCoin.tokenid).to.deep.equal(tokenId);
        }
    });

    it('testCoinSerializationWithLargeValues', () => {
        const values = [
            BigInt(Number.MAX_SAFE_INTEGER),
            BigInt(Number.MAX_SAFE_INTEGER) * 2n,
            BigInt(Number.MAX_SAFE_INTEGER) * 1000n
        ];
        
        for (const value of values) {
            const coin = new Coin(value, NetworkParameters.getBIGT_AI_TOKENID());
            
            const transaction = new Transaction(MainNetParams.get());
            const address = getTestAddress();
            const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(
                MainNetParams.get(), 
                transaction, 
                serialized, 
                0, 
                MainNetParams.get().getDefaultSerializer()
            );
            const deserializedCoin = deserializedOutput.getValue();
            
            expect(deserializedCoin).to.deep.equal(coin);
            expect(deserializedCoin.value).to.equal(coin.value);
            expect(deserializedCoin.tokenid).to.deep.equal(coin.tokenid);
        }
    });

    it('testCoinSerializationRoundTrip', () => {
        const value = 999999999n;
        const tokenId = Buffer.from("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890", "hex");
        const coin = new Coin(value, tokenId);
        
        const transaction = new Transaction(MainNetParams.get());
        const address = getTestAddress();
        const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(
            MainNetParams.get(), 
            transaction, 
            serialized, 
            0, 
            MainNetParams.get().getDefaultSerializer()
        );
        const deserializedCoin = deserializedOutput.getValue();
        
        expect(deserializedCoin).to.deep.equal(coin);
        expect(deserializedCoin.value).to.equal(value);
        expect(deserializedCoin.tokenid).to.deep.equal(tokenId);
        expect(deserializedCoin.isPositive()).to.equal(coin.isPositive());
        expect(deserializedCoin.isNegative()).to.equal(coin.isNegative());
        expect(deserializedCoin.isZero()).to.equal(coin.isZero());
    });

    it('testCoinSerializationWithZeroTokenId', () => {
        const value = 555555n;
        const tokenId = Buffer.alloc(32);
        const coin = new Coin(value, tokenId);
        
        const transaction = new Transaction(MainNetParams.get());
        const address = getTestAddress();
        const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(
            MainNetParams.get(), 
            transaction, 
            serialized, 
            0, 
            MainNetParams.get().getDefaultSerializer()
        );
        const deserializedCoin = deserializedOutput.getValue();
        
        expect(deserializedCoin).to.deep.equal(coin);
        expect(deserializedCoin.value).to.equal(value);
        expect(deserializedCoin.tokenid).to.deep.equal(tokenId);
    });

    it('testCoinEqualityAfterSerialization', () => {
        const value = 777777n;
        const tokenId = NetworkParameters.getBIGT_AI_TOKENID();
        const coin1 = new Coin(value, tokenId);
        const coin2 = new Coin(value, tokenId);
        
        expect(coin1).to.deep.equal(coin2);
        
        const transaction = new Transaction(MainNetParams.get());
        const address = getTestAddress();
        const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin1, address);
        
        const serialized = output.bitcoinSerialize();
        const deserializedOutput = TransactionOutput.fromTransactionOutput(
            MainNetParams.get(), 
            transaction, 
            serialized, 
            0, 
            MainNetParams.get().getDefaultSerializer()
        );
        const deserializedCoin = deserializedOutput.getValue();
        
        expect(deserializedCoin).to.deep.equal(coin1);
        expect(deserializedCoin).to.deep.equal(coin2);
    });

    it('testCoinSerializationWithSpecialValues', () => {
        const specialCoins = [
             CoinConstants.ZERO,
             CoinConstants.COIN,
            CoinConstants.SATOSHI,
          //  Coin.NEGATIVE_SATOSHI,
            CoinConstants.FEE_DEFAULT
        ];
        
        for (const coin of specialCoins) {
            const transaction = new Transaction(MainNetParams.get());
            const address = getTestAddress();
            const output = TransactionOutput.fromAddress(MainNetParams.get(), transaction, coin, address);
            
            const serialized = output.bitcoinSerialize();
            const deserializedOutput = TransactionOutput.fromTransactionOutput(
                MainNetParams.get(), 
                transaction, 
                serialized, 
                0, 
                MainNetParams.get().getDefaultSerializer()
            );
            const deserializedCoin = deserializedOutput.getValue();
            
            expect(deserializedCoin).to.deep.equal(coin);
            expect(deserializedCoin.value).to.equal(coin.value);
            expect(deserializedCoin.tokenid).to.deep.equal(coin.tokenid);
        }
    });
});
