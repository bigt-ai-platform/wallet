import { describe, test, expect } from 'vitest';
import { VarInt } from '../../src/net/bigtangle/core/VarInt';
import { Buffer } from 'buffer';

describe('VarIntTest', () => {
    test('testVarIntEncode', () => {
        // Test case 1: value < 253
        const varInt1 = new VarInt(1);
        const encoded1 = varInt1.encode();
        console.log("VarInt(1) encoded as:", encoded1.toString('hex'));
        expect(encoded1.length).toBe(1);
        expect(encoded1[0]).toBe(1);
        
        // Test case 2: value >= 253 but <= 0xFFFF
        const varInt2 = new VarInt(253);
        const encoded2 = varInt2.encode();
        console.log("VarInt(253) encoded as:", encoded2.toString('hex'));
        expect(encoded2.length).toBe(3);
        expect(encoded2[0]).toBe(253); // marker
        expect(encoded2[1]).toBe(253); // low byte
        expect(encoded2[2]).toBe(0);   // high byte
        
        // Test case 3: value > 0xFFFF but <= 0xFFFFFFFF
        const varInt3 = new VarInt(0x10000);
        const encoded3 = varInt3.encode();
        console.log("VarInt(0x10000) encoded as:", encoded3.toString('hex'));
        expect(encoded3.length).toBe(5);
        expect(encoded3[0]).toBe(254); // marker
    });
    
    test('testVarIntDecode', () => {
        // Test case 1: value < 253
        const buf1 = Buffer.from([1]);
        const varInt1 = VarInt.fromBuffer(buf1, 0);
        expect(Number(varInt1.value)).toBe(1);
        expect(varInt1.getOriginalSizeInBytes()).toBe(1);
        
        // Test case 2: value >= 253 but <= 0xFFFF
        const buf2 = Buffer.from([253, 253, 0]);
        const varInt2 = VarInt.fromBuffer(buf2, 0);
        expect(Number(varInt2.value)).toBe(253);
        expect(varInt2.getOriginalSizeInBytes()).toBe(3);
        
        // Test case 3: value > 0xFFFF but <= 0xFFFFFFFF
        const buf3 = Buffer.from([254, 0, 0, 1, 0]);
        const varInt3 = VarInt.fromBuffer(buf3, 0);
        expect(Number(varInt3.value)).toBe(0x10000);
        expect(varInt3.getOriginalSizeInBytes()).toBe(5);
    });
});
