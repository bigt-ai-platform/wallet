class BigIntegerConverter {
  private value: bigint;
  
  constructor(value: bigint | string | number) {
    this.value = BigInt(value);
  }
  
  private bitLength(): number {
    if (this.value === 0n) return 1;
    
    // Java's BigInteger.bitLength() calculation
    // For 1000000000000n, Java returns a bit length that results in 8 bytes
    // This suggests Java uses: (magnitude.length * 32) - numberOfLeadingZeros(highestInt)
    const magnitude = this.getMagnitude();
    if (magnitude.length === 0) return 1;
    
    const highestInt = magnitude[magnitude.length - 1];
    
    // Count leading zeros in the highest 32-bit int
    let leadingZeros = 0;
    if (highestInt === 0) {
      leadingZeros = 32;
    } else {
      let temp = highestInt;
      if (temp >>> 16 === 0) { leadingZeros += 16; temp <<= 16; }
      if (temp >>> 24 === 0) { leadingZeros += 8; temp <<= 8; }
      if (temp >>> 28 === 0) { leadingZeros += 4; temp <<= 4; }
      if (temp >>> 30 === 0) { leadingZeros += 2; temp <<= 2; }
      if (temp >>> 31 === 0) { leadingZeros += 1; }
    }
    
    const bitLength = magnitude.length * 32 - leadingZeros;
    console.log(`Magnitude: [${magnitude.join(', ')}]`);
    console.log(`Highest int: ${highestInt} (0x${highestInt.toString(16)})`);
    console.log(`Leading zeros: ${leadingZeros}`);
    console.log(`Calculated bit length: ${bitLength}`);
    
    return bitLength;
  }
  
  private getInt(intIndex: number): number {
    // Java BigInteger stores magnitude in int[] array
    // We need to simulate this by converting to Java's internal representation
    const magnitude = this.getMagnitude();
    if (intIndex >= magnitude.length) return 0;
    return magnitude[intIndex];
  }
  
  private getMagnitude(): number[] {
    if (this.value === 0n) return [0];
    
    const abs = this.value < 0n ? -this.value : this.value;
    const magnitude: number[] = [];
    let temp = abs;
    
    while (temp > 0n) {
      const chunk = Number(temp & 0xFFFFFFFFn);
      magnitude.push(chunk);
      temp >>= 32n;
    }
    
    return magnitude;
  }
  
  public toByteArray(): Uint8Array {
    //console.log(`\n=== Converting ${this.value} ===`);

    if (this.value === 0n) {
      return new Uint8Array([0]);
    }

    // Handle negative numbers correctly
    const isNegative = this.value < 0n;
    const absValue = isNegative ? -this.value : this.value;

    // Convert to byte array (big-endian)
    let temp = absValue;
    const bytes: number[] = [];

    while (temp > 0n) {
      bytes.push(Number(temp & 0xFFn));
      temp >>= 8n;
    }

    // Reverse to get big-endian
    bytes.reverse();

    // For positive numbers, if the most significant bit is 1, Java adds a leading 0x00 byte
    // to indicate the number is positive (since high bit 1 would indicate negative in two's complement)
    if (!isNegative && bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
        bytes.unshift(0);
    }

    // For negative numbers, we need to ensure two's complement representation
    if (isNegative) {
      // If the most significant bit is set, we need to add a leading zero byte
      // to indicate that the number is negative
      if ((bytes[0] & 0x80) !== 0) {
        bytes.unshift(0);
      }

      // Convert to two's complement
      let carry = 1;
      for (let i = bytes.length - 1; i >= 0; i--) {
        const inverted = (~bytes[i] & 0xFF) + carry;
        bytes[i] = inverted & 0xFF;
        carry = inverted >> 8;
      }
    }

    //console.log(`Final result: [${bytes.map(b => b > 127 ? b - 256 : b).join(', ')}]`);
    return new Uint8Array(bytes);
  }
  
  static fromByteArray(bytes: Uint8Array): BigIntegerConverter {
    if (bytes.length === 0) return new BigIntegerConverter(0n);
    
    
    // For Bitcoin transaction values, always treat as unsigned
    // The MSB being set does not indicate a negative number in Bitcoin context
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
      result = (result << 8n) | BigInt(bytes[i]);
    }
 
    // Return the unsigned interpretation for Bitcoin transaction values
    return new BigIntegerConverter(result);
  }
  
  public getValue(): bigint {
    return this.value;
  }
  
  public toString(radix: number = 10): string {
    return this.value.toString(radix);
  }
}

export function bigIntToBytes(value: bigint): Uint8Array {
  return new BigIntegerConverter(value).toByteArray();
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigIntegerConverter.fromByteArray(bytes).getValue();
}

// Test function to verify compatibility
export function testValue(value: bigint): void {
  const converter = new BigIntegerConverter(value);
  const bytes = converter.toByteArray();
  const reconstructed = BigIntegerConverter.fromByteArray(bytes);
  
  console.log(`Value: ${value}`);
  console.log(`Bit length: ${converter['bitLength']()}`);
  console.log(`Byte length: ${bytes.length}`);
  console.log(`Bytes: [${Array.from(bytes).map(b => b > 127 ? b - 256 : b).join(', ')}]`);
  console.log(`Bytes (unsigned): [${Array.from(bytes).join(', ')}]`);
  console.log(`Reconstructed: ${reconstructed.getValue()}`);
  console.log(`Match: ${value === reconstructed.getValue()}`);
}

export { BigIntegerConverter };

// Test function to verify the specific issue with 10000000
export function testSpecificIssue(): void {
  const originalValue = 10000000n;
  console.log('\n=== Testing Specific Issue with 10000000 ===');
  testValue(originalValue);
  
  // Also test the negative value that was being produced
  const negativeValue = -6777216n;
  console.log('\n=== Testing Negative Value (-6777216) ===');
  testValue(negativeValue);
}

