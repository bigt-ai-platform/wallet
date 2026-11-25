const { Buffer } = require('buffer');

// Test a small portion of the hex string
const smallHex = "01000000ae"; // 10 characters

console.log('Small hex string:', smallHex);
console.log('Length:', smallHex.length);

// Method 1: Direct hex decode
const buffer1 = Buffer.from(smallHex, 'hex');
console.log('Method 1 - Buffer:', buffer1.toString('hex'));
console.log('Method 1 - Buffer bytes:', [...buffer1]);

// Method 2: Correct simulation of Utils.HEX.decode
function simulateUtilsHexDecode(hexString) {
  // Pad with leading zero if length is odd
  if (hexString.length % 2 === 1) {
    hexString = '0' + hexString;
  }
  
  const target = new Uint8Array(Math.floor(hexString.length / 2));
  let bytesWritten = 0;
  
  // This is a simplified version of the alphabet decoding
  const alphabet = '0123456789abcdef';
  const decodabet = new Array(256);
  for (let i = 0; i < alphabet.length; i++) {
    decodabet[alphabet.charCodeAt(i)] = i;
  }
  
  function decodeChar(c) {
    const code = c.toLowerCase().charCodeAt(0);
    return decodabet[code];
  }
  
  for (let i = 0; i < hexString.length; i += 2) {
    const high = decodeChar(hexString.charAt(i));
    if (i + 1 < hexString.length) {
      const low = decodeChar(hexString.charAt(i + 1));
      const decoded = (high << 4) | low;
      target[bytesWritten++] = decoded;
    } else {
      // Handle odd case - single nibble
      target[bytesWritten++] = high;
    }
  }
  
  return Buffer.from(target);
}

const buffer2 = simulateUtilsHexDecode(smallHex);
console.log('Method 2 - Buffer:', buffer2.toString('hex'));
console.log('Method 2 - Buffer bytes:', [...buffer2]);

// What should be the correct decoding of "01000000ae"?
// It should be: 0x01, 0x00, 0x00, 0x00, 0xae
console.log('Expected bytes: [1, 0, 0, 0, 174]');

// The issue is that the original hex string has 1065 characters (odd)
// So Utils.HEX.decode adds a leading '0' to make it 1066 characters
// "01000000ae..." becomes "001000000ae..."
// Which decodes as: 0x00, 0x10, 0x00, 0x00, 0x0a, 0xe0, ...

const oddHex = "1000000ae"; // 9 characters (odd)
console.log('\nOdd hex string:', oddHex);
console.log('Length:', oddHex.length);

const buffer3 = Buffer.from(oddHex, 'hex');
console.log('Direct decode of odd hex - Buffer bytes:', [...buffer3]);

const buffer4 = simulateUtilsHexDecode(oddHex);
console.log('Utils.HEX.decode of odd hex - Buffer bytes:', [...buffer4]);

// Let's also test what happens with the actual original hex string
const originalTipStart = "01000000ae579cc5d5854d46e38495665fefad8b2dc110a083abcf7dae970bed19f05548";
console.log('\nOriginal tip start:', originalTipStart);
console.log('Length:', originalTipStart.length);

const buffer5 = Buffer.from(originalTipStart, 'hex');
console.log('Direct decode - Buffer bytes:', [...buffer5]);

const buffer6 = simulateUtilsHexDecode(originalTipStart);
console.log('Utils.HEX.decode - Buffer bytes:', [...buffer6]);
