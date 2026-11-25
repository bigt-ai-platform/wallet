const { Buffer } = require('buffer');

console.log('=== Test readInt64 ===');

// Create a buffer with the height bytes
// Height should be 4096 (0x1000) in little-endian 64-bit format
// 00 00 10 00 00 00 00 00
const heightBuffer = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
console.log('Height buffer:', heightBuffer.toString('hex'));

// Implement readInt64 function
function readInt64(bytes, offset) {
    const low = (bytes[offset] & 0xff) |
                ((bytes[offset + 1] & 0xff) << 8) |
                ((bytes[offset + 2] & 0xff) << 16) |
                ((bytes[offset + 3] & 0xff) << 24);
    const high = (bytes[offset + 4] & 0xff) |
                 ((bytes[offset + 5] & 0xff) << 8) |
                 ((bytes[offset + 6] & 0xff) << 16) |
                 ((bytes[offset + 7] & 0xff) << 24);
    // Convert to BigInt to properly handle 64-bit values
    return BigInt(low) + (BigInt(high) << 32n);
}

const height = readInt64(heightBuffer, 0);
console.log('Height value:', height.toString());

// Test with the actual bytes from the payload
const tip =
  "01000000ae579cc5d5854d46e38495665fefad8b2dc110a083abcf7dae970bed19f05548ae579cc5d5854d46e38495665fefad8b2dc110a083abcf7dae970bed19f05548170dafec26b25ed20a2c87d485de589c57fc1b32e65a37ea970feb15142b5f1a2a34856800000000ae470120000000000000000000000000cb16b4d62bdf6a05a961cf27a47355486891ebb9ee6892f8010000000100000000000000010100000001ae579cc5d5854d46e38495665fefad8b2dc110a083abcf7dae970bed19f055488b404ea4787ac1af3c007dc3462b9875d320ee983690b649d9c564da7a4c38d50000000049483045022100818570e724f91eb5d73b6a195c905fe7d56414cd39fef6aaba20d10f60402256022011f04e032d4bcd111218d07f32195e29f9e3dbb4ef517f91d596e248f84c08c201ffffffff0100000008016345785d8a000001bc232102721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975ac02030f424001bc1976a91451d65cb4f2e64551c447cd41635dd9214bbaf19d88ac08016345785d7ab9d801bc232102721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975ac00000000000000000000000000000000420000007b0a2020226b7622203a205b207b0a20202020226b657922203a20226d656d6f222c0a202020202276616c756522203a20227061794c697374220a20207d205da7d00000000";

const originalBuffer = Buffer.from(tip, 'hex');
console.log('\nOriginal buffer length:', originalBuffer.length);

// Check bytes at cursor 152 (height)
console.log('\nBytes at cursor 152 (height):');
for (let i = 152; i < 160; i++) {
  console.log(`  Offset ${i}: 0x${originalBuffer[i].toString(16).padStart(2, '0')}`);
}

// Read the height using readInt64
const heightFromPayload = readInt64(originalBuffer, 152);
console.log('Height from payload:', heightFromPayload.toString());

// Check byte at cursor 160 (transaction count)
console.log('\nByte at cursor 160 (transaction count):');
console.log(`  Offset 160: 0x${originalBuffer[160].toString(16).padStart(2, '0')}`);
