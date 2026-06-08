import { Script } from '../../src/net/bigtangle/script/Script';
import { ScriptException } from '../../src/net/bigtangle/exception/ScriptException';
import { describe, test, expect } from 'vitest';

describe('ScriptParseTest', () => {
    test('testParseWithInsufficientDataForPushData1', () => {
        // Create a script with OP_PUSHDATA1 but insufficient data
        // OP_PUSHDATA1 (0x4c) followed by 0x05 (indicating 5 bytes to read)
        // but only provide 1 byte instead of 5
        const scriptBytes = Buffer.from([0x4c, 0x05, 0x01]); // Only 1 data byte instead of 5
        
        expect(() => {
            new Script(scriptBytes);
        }).toThrow(ScriptException);
        
        try {
            new Script(scriptBytes);
        } catch (e: any) {
            expect(e.message).toBe('Push of data element that is larger than remaining data');
        }
    });

    test('testParseWithInsufficientDataForPushData2', () => {
        // Create a script with OP_PUSHDATA2 but insufficient data
        // OP_PUSHDATA2 (0x4d) followed by 0x05 0x00 (indicating 5 bytes to read in little-endian)
        // but only provide 1 byte instead of 5
        const scriptBytes = Buffer.from([0x4d, 0x05, 0x00, 0x01]); // Only 1 data byte instead of 5
        
        expect(() => {
            new Script(scriptBytes);
        }).toThrow(ScriptException);
        
        try {
            new Script(scriptBytes);
        } catch (e: any) {
            expect(e.message).toBe('Push of data element that is larger than remaining data');
        }
    });

    test('testParseWithInsufficientDataForPushData4', () => {
        // Create a script with OP_PUSHDATA4 but insufficient data
        // OP_PUSHDATA4 (0x4e) followed by 0x05 0x00 0x00 0x00 (indicating 5 bytes to read in little-endian)
        // but only provide 1 byte instead of 5
        const scriptBytes = Buffer.from([0x4e, 0x05, 0x00, 0x00, 0x00, 0x01]); // Only 1 data byte instead of 5
        
        expect(() => {
            new Script(scriptBytes);
        }).toThrow(ScriptException);
        
        try {
            new Script(scriptBytes);
        } catch (e: any) {
            expect(e.message).toBe('Push of data element that is larger than remaining data');
        }
    });

    test('testParseWithInsufficientDataForSmallPush', () => {
        // Create a script with a small push operation but insufficient data
        // 0x05 (indicating 5 bytes to read) but only provide 1 byte instead of 5
        const scriptBytes = Buffer.from([0x05, 0x01]); // Only 1 data byte instead of 5
        
        expect(() => {
            new Script(scriptBytes);
        }).toThrow(ScriptException);
        
        try {
            new Script(scriptBytes);
        } catch (e: any) {
            expect(e.message).toBe('Push of data element that is larger than remaining data');
        }
    });
});
