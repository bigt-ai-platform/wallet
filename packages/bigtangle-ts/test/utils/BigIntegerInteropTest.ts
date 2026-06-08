import { describe, test, expect } from 'vitest';
import { Utils } from '../../src/net/bigtangle/utils/Utils';

describe('BigInt Interoperability Tests', () => {
    // Test cases for positive numbers
    test('should correctly convert positive BigInt to bytes and back', () => {
        const testValues = [
            BigInt(0),
            BigInt(1),
            BigInt(127),
            BigInt(128),
            BigInt(255),
            BigInt(256),
            BigInt(1000),
            BigInt(65535),
            BigInt(65536),
            BigInt('12345678901234567890')
        ];

        for (const value of testValues) {
            const bytes = Utils.bigIntToBytes(value);
            const restored = Utils.bytesToBigInt(bytes);
            console.log(`Value: ${value.toString()}, Bytes: [${Array.from(bytes).join(',')}], Restored: ${restored.toString()}`);
            expect(restored).toBe(value);
        }
    });

    // Test cases for negative numbers
    test('should correctly convert negative BigInt to bytes and back', () => {
        const testValues = [
            BigInt(-1),
            BigInt(-128),
            BigInt(-255),
            BigInt(-256),
            BigInt(-1000),
            BigInt(-65535),
            BigInt(-65536),
            BigInt('-12345678901234567890')
        ];

        for (const value of testValues) {
            const bytes = Utils.bigIntToBytes(value);
            const restored = Utils.bytesToBigInt(bytes);
            expect(restored).toBe(value);
        }
    });

    // Test specific byte patterns that might be problematic
    test('should handle edge cases correctly', () => {
        // Test value that would need sign bit
        const positiveWithMSB = BigInt(128); // 0x80
        const bytes1 = Utils.bigIntToBytes(positiveWithMSB);
        const restored1 = Utils.bytesToBigInt(bytes1);
        expect(restored1).toBe(positiveWithMSB);
        // Should have leading zero to indicate positive
        expect(bytes1[0]).toBe(0);
        expect(bytes1[1]).toBe(128);

        // Test negative value
        const negative = BigInt(-128); // -0x80
        const bytes2 = Utils.bigIntToBytes(negative);
        const restored2 = Utils.bytesToBigInt(bytes2);
        expect(restored2).toBe(negative);
        // Should have MSB set to indicate negative
        expect((bytes2[0] & 0x80) !== 0).toBe(true);
    });

    // Test round-trip conversion
    test('should maintain round-trip conversion integrity', () => {
        const testValues = [
            BigInt(0),
            BigInt(1),
            BigInt(-1),
            BigInt(127),
            BigInt(-128),
            BigInt(255),
            BigInt(-255),
            BigInt('9223372036854775807'), // Max safe integer in JavaScript
            BigInt('-9223372036854775808'), // Min safe integer in JavaScript
        ];

        for (const value of testValues) {
            // Convert to bytes and back
            const bytes = Utils.bigIntToBytes(value);
            const restored = Utils.bytesToBigInt(bytes);
            
            // Verify the restored value equals the original
            expect(restored).toBe(value);
            
            // Verify the string representations match
            expect(restored.toString()).toBe(value.toString());
        }
    });
});
