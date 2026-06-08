import { TransactionOutPoint } from '../../src/net/bigtangle/core/TransactionOutPoint';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Buffer } from 'buffer';
import { UnsafeByteArrayOutputStream } from '../../src/net/bigtangle/core/UnsafeByteArrayOutputStream';
import { describe, test, expect } from 'vitest';

describe('TransactionOutPointTest', () => {
    const PARAMS = MainNetParams.get();

    test('testSerialization', () => {
        // Create a TransactionOutPoint with specific values
        const blockHashBytes = Buffer.alloc(32);
        blockHashBytes.fill('b');
        const txHashBytes = Buffer.alloc(32);
        txHashBytes.fill('t');
        const blockHash = Sha256Hash.wrap(blockHashBytes);
        const txHash = Sha256Hash.wrap(txHashBytes);
        const outpoint =   TransactionOutPoint.fromTransactionOutPoint4(PARAMS, 123, blockHash, txHash);

        // Serialize it
        const stream = new UnsafeByteArrayOutputStream();
        outpoint.bitcoinSerializeToStream(stream);
        const serialized = stream.toByteArray();

        // Deserialize it
        const deserialized = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());

        // Check that the deserialized object matches the original
        expect(deserialized.getBlockHash().equals(blockHash)).toBe(true);
        expect(deserialized.getTxHash().equals(txHash)).toBe(true);
        expect(deserialized.getIndex()).toBe(123);
    });

    test('testSerializationWithZeroHashes', () => {
        // Create a TransactionOutPoint with zero hashes
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(PARAMS, 456, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH);

        // Serialize it
        const stream = new UnsafeByteArrayOutputStream();
        outpoint.bitcoinSerializeToStream(stream);
        const serialized = stream.toByteArray();

        // Deserialize it
        const deserialized = TransactionOutPoint.fromTransactionOutPoint5(PARAMS, serialized, 0, null, PARAMS.getDefaultSerializer());

        // Check that the deserialized object matches the original
        expect(deserialized.getBlockHash().equals(Sha256Hash.ZERO_HASH)).toBe(true);
        expect(deserialized.getTxHash().equals(Sha256Hash.ZERO_HASH)).toBe(true);
        expect(deserialized.getIndex()).toBe(456);
    });
});
