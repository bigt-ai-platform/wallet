const { VarInt } = require('../../src/net/bigtangle/core/VarInt');

// Test the VarInt parsing at the position where it's failing
const buffer = Buffer.from('0100000008016345785d6b73b001bc232102721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975ac02030f424001bc1976a91451d65cb4f2e64551c447cd41635dd9214bbaf19d88ac08016345785d5c2d8801bc232102721b5eb0282e4bc86aab3380e2bba31d935cba386741c15447973432c61bc975ac00000000000000000000000000000000420000007b0a2020226b7622203a205b207b0a20202020226b657922203a20226d656d6f222c0a202020202276616c756522203a20227061794c697374220a20207d205d0a7d00000000', 'hex');

console.log('Buffer length:', buffer.length);

// Try to parse VarInt at different positions
for (let i = 0; i < Math.min(10, buffer.length); i++) {
  try {
    const varInt = VarInt.fromBuffer(buffer, i);
    console.log(`VarInt at position ${i}: value=${varInt.value.toString()}, size=${varInt.getOriginalSizeInBytes()}`);
  } catch (e) {
    console.log(`Error parsing VarInt at position ${i}: ${e.message}`);
  }
}
