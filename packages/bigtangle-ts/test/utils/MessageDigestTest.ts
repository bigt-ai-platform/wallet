import { SHA256Digest } from '../../src/net/bigtangle/utils/SHA256Digest';
import { Buffer } from 'buffer';
import { describe, test, expect } from 'vitest';

describe('MessageDigest', () => {
  test('should create a SHA-256 digest instance', () => {
    const digest = SHA256Digest.getInstance('SHA-256');
    expect(digest).toBeDefined();
    expect(digest.getAlgorithm()).toBe('SHA-256');
  });

  test('should create a SHA-256 digest instance using from method', () => {
    const digest = SHA256Digest.from('SHA-256');
    expect(digest).toBeDefined();
    expect(digest.getAlgorithm()).toBe('SHA-256');
  });

  test('should throw an error for unsupported algorithms', () => {
    expect(() => SHA256Digest.getInstance('UNSUPPORTED')).toThrow();
  });

  test('should compute SHA-256 digest correctly', () => {
    const digest = SHA256Digest.getInstance('SHA-256');
    const input = Buffer.from('hello world', 'utf8');
    digest.update(input);
    const result = digest.digest();

    // Expected SHA-256 hash of "hello world"
    const expected = Buffer.from('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', 'hex');
    // Convert both to Uint8Array for comparison to handle different internal representations
    expect(new Uint8Array(result)).toEqual(new Uint8Array(expected));
  });

  test('should reset and reuse the digest', () => {
    const digest = SHA256Digest.getInstance('SHA-256');

    // First hash
    const input1 = Buffer.from('hello', 'utf8');
    digest.update(input1);
    const result1 = digest.digest();

    // Reset and hash again
    digest.reset();
    const input2 = Buffer.from('hello', 'utf8');
    digest.update(input2);
    const result2 = digest.digest();

    // Results should be the same
    expect(new Uint8Array(result1)).toEqual(new Uint8Array(result2));
  });
});
