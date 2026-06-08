import { MessageDigest } from "./MessageDigest";
import { SHA256Digest } from "./SHA256Digest";

export class MessageDigestFactory {
  public static getInstance(algorithm: string): MessageDigest {
    switch (algorithm.toUpperCase()) {
      case "SHA-256":
      case "SHA256":
        return SHA256Digest.getInstance(algorithm);
      // Add more cases for other algorithms as needed
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }

  public static from(algorithm: string): MessageDigest {
    return MessageDigestFactory.getInstance(algorithm);
  }
}
