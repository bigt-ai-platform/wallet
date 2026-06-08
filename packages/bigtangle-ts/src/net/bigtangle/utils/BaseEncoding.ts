/*
 * Copyright (C) 2012 The Guava Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing permissions and limitations under
 * the License.
 */

// Helper functions to replace Guava's Preconditions
function checkArgument(condition: boolean, errorMessage?: string, ...args: any[]) {
  if (!condition) {
    let message = errorMessage || 'Illegal argument';
    if (args.length > 0) {
      message = message.replace(/%s/g, () => args.shift());
    }
    throw new Error(message);
  }
}

function checkState(condition: boolean, errorMessage?: string, ...args: any[]) {
    if (!condition) {
        let message = errorMessage || 'Illegal state';
        if (args.length > 0) {
            message = message.replace(/%s/g, () => args.shift());
        }
        throw new Error(message);
    }
}

function checkNotNull<T>(value: T | null | undefined, errorMessage?: string): T {
  if (value === null || value === undefined) {
    throw new Error(errorMessage || 'Null pointer exception');
  }
  return value;
}

function checkPositionIndexes(start: number, end: number, size: number) {
  if (start < 0 || end < start || end > size) {
    throw new RangeError(`Invalid range: [${start}, ${end}) for size ${size}`);
  }
}

// Helper for integer math
const IntMath = {
    divide: (p: number, q: number, mode: 'CEILING' | 'FLOOR' | 'UNNECESSARY'): number => {
        const result = p / q;
        switch (mode) {
            case 'CEILING':
                return Math.ceil(result);
            case 'FLOOR':
                return Math.floor(result);
            case 'UNNECESSARY':
                checkArgument(Number.isInteger(result), "Rounding necessary");
                return result;
        }
    },
    log2: (x: number, mode: 'UNNECESSARY'): number => {
        const result = Math.log2(x);
        checkArgument(Number.isInteger(result), "Rounding necessary for log2");
        return result;
    }
};

// ASCII helpers
const Ascii = {
    MAX: 127,
    isLowerCase: (c: string): boolean => c >= 'a' && c <= 'z',
    isUpperCase: (c: string): boolean => c >= 'A' && c <= 'Z',
    toUpperCase: (c: string): string => c.toUpperCase(),
    toLowerCase: (c: string): string => c.toLowerCase(),
};

/**
 * Exception indicating invalid base-encoded input encountered while decoding.
 */
export class DecodingException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodingException";
  }
}

class Alphabet {
  readonly name: string;
  private readonly chars: string[];
  readonly mask: number;
  readonly bitsPerChar: number;
  readonly charsPerChunk: number;
  readonly bytesPerChunk: number;
  private readonly decodabet: Int8Array;
  private readonly validPadding: boolean[];
  private readonly ignoreCase: boolean;

    constructor(name: string, chars: string[], decodabet?: Int8Array, ignoreCase = false) {
    this.name = checkNotNull(name);
    this.chars = checkNotNull(chars);
    try {
      this.bitsPerChar = IntMath.log2(chars.length, 'UNNECESSARY');
    } catch (e) {
      throw new Error("Illegal alphabet length " + chars.length);
    }

    const zeroesInBitsPerChar = 31 - Math.clz32(this.bitsPerChar); // Equivalent to Integer.numberOfTrailingZeros
    this.charsPerChunk = 1 << (3 - zeroesInBitsPerChar);
    this.bytesPerChunk = this.bitsPerChar >> zeroesInBitsPerChar;

    this.mask = chars.length - 1;

    if (decodabet) {
        this.decodabet = decodabet;
    } else {
        this.decodabet = new Int8Array(Ascii.MAX + 1);
        this.decodabet.fill(-1);
        for (let i = 0; i < chars.length; i++) {
            const c = chars[i];
            const code = c.charCodeAt(0);
            checkArgument(code < this.decodabet.length, "Non-ASCII character: %s", c);
            checkArgument(this.decodabet[code] === -1, "Duplicate character: %s", c);
            this.decodabet[code] = i;
        }
    }

    this.validPadding = new Array(this.charsPerChunk).fill(false);
    for (let i = 0; i < this.bytesPerChunk; i++) {
      this.validPadding[IntMath.divide(i * 8, this.bitsPerChar, 'CEILING')] = true;
    }
    this.ignoreCase = ignoreCase;
  }

  /** Returns an equivalent `Alphabet` except it ignores case. */
  ignoreCaseVersion(): Alphabet {
    if (this.ignoreCase) {
      return this;
    }
    const newDecodabet = new Int8Array(this.decodabet);
    for (let upper = 'A'.charCodeAt(0); upper <= 'Z'.charCodeAt(0); upper++) {
      const lower = upper | 0x20;
      const decodeUpper = this.decodabet[upper];
      const decodeLower = this.decodabet[lower];
      if (decodeUpper === -1) {
        newDecodabet[upper] = decodeLower;
      } else {
        checkState(decodeLower === -1, "Can't ignoreCase() since '%s' and '%s' encode different values",
            String.fromCharCode(upper), String.fromCharCode(lower));
        newDecodabet[lower] = decodeUpper;
      }
    }
    return new Alphabet(this.name + ".ignoreCase()", this.chars, newDecodabet, true);
  }


  encode(bits: number): string {
    return this.chars[bits];
  }

  isValidPaddingStartPosition(index: number): boolean {
    return this.validPadding[index % this.charsPerChunk];
  }

  canDecode(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return code <= Ascii.MAX && this.decodabet[code] !== -1;
  }

  decode(ch: string): number {
    const code = ch.charCodeAt(0);
    if (code > Ascii.MAX) {
      throw new DecodingException("Unrecognized character: 0x" + code.toString(16));
    }
    const result = this.decodabet[code];
    if (result === -1) {
      if (code <= 0x20 || code === Ascii.MAX) {
        throw new DecodingException("Unrecognized character: 0x" + code.toString(16));
      } else {
        throw new DecodingException("Unrecognized character: " + ch);
      }
    }
    return result;
  }

  private hasLowerCase(): boolean {
      return this.chars.some(c => Ascii.isLowerCase(c));
  }

  private hasUpperCase(): boolean {
      return this.chars.some(c => Ascii.isUpperCase(c));
  }

  upperCase(): Alphabet {
    if (!this.hasLowerCase()) {
      return this;
    }
    checkState(!this.hasUpperCase(), "Cannot call upperCase() on a mixed-case alphabet");
    const upperCased = this.chars.map(c => Ascii.toUpperCase(c));
    const upperCase = new Alphabet(this.name + ".upperCase()", upperCased);
    return this.ignoreCase ? upperCase.ignoreCaseVersion() : upperCase;
  }

  lowerCase(): Alphabet {
    if (!this.hasUpperCase()) {
      return this;
    }
    checkState(!this.hasLowerCase(), "Cannot call lowerCase() on a mixed-case alphabet");
    const lowerCased = this.chars.map(c => Ascii.toLowerCase(c));
    const lowerCase = new Alphabet(this.name + ".lowerCase()", lowerCased);
    return this.ignoreCase ? lowerCase.ignoreCaseVersion() : lowerCase;
  }

  public matches(c: string): boolean {
    const code = c.charCodeAt(0);
    return code < this.decodabet.length && this.decodabet[code] !== -1;
  }

  public getCharsLength(): number {
    return this.chars.length;
  }

  public getCharsString(): string {
    return this.chars.join('');
  }

  toString(): string {
    return this.name;
  }

    equals(other: any): boolean {
        if (other instanceof Alphabet) {
            return this.ignoreCase === other.ignoreCase && this.chars.join('') === other.chars.join('');
        }
        return false;
    }
}

/**
 * A binary encoding scheme for reversibly translating between byte sequences and printable ASCII
 * strings.
 */
export abstract class BaseEncoding {

  // A simple string builder for performance
  protected static StringBuilder = class {
      private parts: string[] = [];
      append(s: string): this {
          this.parts.push(s);
          return this;
      }
      toString(): string {
          return this.parts.join('');
      }
  };

  /**
   * Encodes the specified byte array, and returns the encoded `String`.
   */
  public encode(bytes: Uint8Array): string;
  /**
   * Encodes the specified range of the specified byte array, and returns the encoded `String`.
   */
  public encode(bytes: Uint8Array, off: number, len: number): string;
  public encode(bytes: Uint8Array, off?: number, len?: number): string {
    const offset = off ?? 0;
    const length = len ?? bytes.length;
    checkPositionIndexes(offset, offset + length, bytes.length);
    const result = new BaseEncoding.StringBuilder();
    this.encodeTo(result, bytes, offset, length);
    return result.toString();
  }

  private static extract(result: Uint8Array, length: number): Uint8Array {
    if (length === result.length) {
      return result;
    }
    return result.slice(0, length);
  }

  /**
   * Determines whether the specified character sequence is a valid encoded string according to this
   * encoding.
   */
  public abstract canDecode(chars: string): boolean;

  /**
   * Decodes the specified character sequence, and returns the resulting `Uint8Array`.
   */
  public decode(chars: string): Uint8Array {
    try {
      return this.decodeChecked(chars);
    } catch (badInput) {
      if (badInput instanceof DecodingException) {
          throw new Error(badInput.message);
      }
      throw badInput;
    }
  }

  /**
   * Decodes the specified character sequence, and returns the resulting `Uint8Array`.
   * @throws DecodingException if the input is not a valid encoded string
   */
  decodeChecked(chars: string): Uint8Array {
    chars = this.trimTrailingPadding(chars);
    const tmp = new Uint8Array(this.maxDecodedSize(chars.length));
    const len = this.decodeTo(tmp, chars);
    return BaseEncoding.extract(tmp, len);
  }

  // Abstract methods for implementation by subclasses
  abstract maxEncodedSize(bytes: number): number;
  abstract encodeTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number): void;
  abstract maxDecodedSize(chars: number): number;
  abstract decodeTo(target: Uint8Array, chars: string): number;

  trimTrailingPadding(chars: string): string {
    return checkNotNull(chars);
  }

  // Configuration methods
  public abstract omitPadding(): BaseEncoding;
  public abstract withPadChar(padChar: string): BaseEncoding;
  public abstract withSeparator(separator: string, n: number): BaseEncoding;
  public abstract upperCase(): BaseEncoding;
  public abstract lowerCase(): BaseEncoding;
  public abstract ignoreCase(): BaseEncoding;
  
  // Static factory methods
  private static BASE64_INSTANCE: BaseEncoding;
  public static base64(): BaseEncoding {
    if (!this.BASE64_INSTANCE) {
        this.BASE64_INSTANCE = new Base64Encoding(
            "base64()", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", '=');
    }
    return this.BASE64_INSTANCE;
  }
  
  private static BASE64_URL_INSTANCE: BaseEncoding;
  public static base64Url(): BaseEncoding {
      if (!this.BASE64_URL_INSTANCE) {
        this.BASE64_URL_INSTANCE = new Base64Encoding(
            "base64Url()", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", '=');
      }
      return this.BASE64_URL_INSTANCE;
  }

  private static BASE32_INSTANCE: BaseEncoding;
  public static base32(): BaseEncoding {
      if (!this.BASE32_INSTANCE) {
          this.BASE32_INSTANCE = new StandardBaseEncoding("base32()", "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", '=');
      }
      return this.BASE32_INSTANCE;
  }
  
  private static BASE32_HEX_INSTANCE: BaseEncoding;
  public static base32Hex(): BaseEncoding {
      if (!this.BASE32_HEX_INSTANCE) {
        this.BASE32_HEX_INSTANCE = new StandardBaseEncoding("base32Hex()", "0123456789ABCDEFGHIJKLMNOPQRSTUV", '=');
      }
      return this.BASE32_HEX_INSTANCE;
  }
  
  private static BASE16_INSTANCE: BaseEncoding;
  public static base16(): BaseEncoding {
      if (!this.BASE16_INSTANCE) {
        this.BASE16_INSTANCE = new Base16Encoding("base16()", "0123456789ABCDEF");
      }
      return this.BASE16_INSTANCE;
  }
}

class StandardBaseEncoding extends BaseEncoding {
  readonly alphabet: Alphabet;
  readonly paddingChar: string | null;

  private upperCaseEncoding: BaseEncoding | null = null;
  private lowerCaseEncoding: BaseEncoding | null = null;
  private ignoreCaseEncoding: BaseEncoding | null = null;

  // Overload 1: For creating with an existing Alphabet
  constructor(alphabet: Alphabet, paddingChar?: string | null);
  // Overload 2: For creating with a name and alphabet characters string
  constructor(name: string, alphabetChars: string, paddingChar?: string | null);

  constructor(nameOrAlphabet: string | Alphabet, alphabetCharsOrPaddingChar?: string | null, paddingChar?: string | null) {
    super();
    if (nameOrAlphabet instanceof Alphabet) {
      this.alphabet = nameOrAlphabet;
      this.paddingChar = alphabetCharsOrPaddingChar === undefined ? null : alphabetCharsOrPaddingChar;
    } else {
      this.alphabet = new Alphabet(nameOrAlphabet, (alphabetCharsOrPaddingChar as string).split(''));
      this.paddingChar = paddingChar === undefined ? null : paddingChar;
    }
    checkArgument(
      this.paddingChar === null || !this.alphabet.matches(this.paddingChar),
      "Padding character %s was already in alphabet", this.paddingChar
    );
  }
  
  maxEncodedSize(bytes: number): number {
    return this.alphabet.charsPerChunk * IntMath.divide(bytes, this.alphabet.bytesPerChunk, 'CEILING');
  }

    encodeTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number) {
        checkNotNull(target);
        checkPositionIndexes(off, off + len, bytes.length);
        for (let i = 0; i < len; i += this.alphabet.bytesPerChunk) {
            this.encodeChunkTo(target, bytes, off + i, Math.min(this.alphabet.bytesPerChunk, len - i));
        }
    }

    encodeChunkTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number) {
        checkNotNull(target);
        checkPositionIndexes(off, off + len, bytes.length);
        checkArgument(len <= this.alphabet.bytesPerChunk);
        let bitBuffer = 0;
        for (let i = 0; i < len; ++i) {
            bitBuffer |= bytes[off + i] & 0xFF;
            bitBuffer <<= 8;
        }
        const bitOffset = (len + 1) * 8 - this.alphabet.bitsPerChar;
        let bitsProcessed = 0;
        while (bitsProcessed < len * 8) {
            const charIndex = (bitBuffer >>> (bitOffset - bitsProcessed)) & this.alphabet.mask;
            target.append(this.alphabet.encode(charIndex));
            bitsProcessed += this.alphabet.bitsPerChar;
        }
        if (this.paddingChar !== null) {
            while (bitsProcessed < this.alphabet.bytesPerChunk * 8) {
                target.append(this.paddingChar);
                bitsProcessed += this.alphabet.bitsPerChar;
            }
        }
    }

  maxDecodedSize(chars: number): number {
    return Math.trunc((this.alphabet.bitsPerChar * chars + 7) / 8);
  }

  trimTrailingPadding(chars: string): string {
    checkNotNull(chars);
    if (this.paddingChar === null) {
      return chars;
    }
    const padChar = this.paddingChar;
    let l = chars.length - 1;
    while (l >= 0 && chars.charAt(l) === padChar) {
      l--;
    }
    return chars.substring(0, l + 1);
  }

  canDecode(chars: string): boolean {
    checkNotNull(chars);
    chars = this.trimTrailingPadding(chars);
    if (!this.alphabet.isValidPaddingStartPosition(chars.length)) {
      return false;
    }
    for (let i = 0; i < chars.length; i++) {
      if (!this.alphabet.canDecode(chars.charAt(i))) {
        return false;
      }
    }
    return true;
  }

    decodeTo(target: Uint8Array, chars: string): number {
        checkNotNull(target);
        chars = this.trimTrailingPadding(chars);
        if (!this.alphabet.isValidPaddingStartPosition(chars.length)) {
            throw new DecodingException("Invalid input length " + chars.length);
        }
        let bytesWritten = 0;
        for (let charIdx = 0; charIdx < chars.length; charIdx += this.alphabet.charsPerChunk) {
            let chunk = 0;
            let charsProcessed = 0;
            for (let i = 0; i < this.alphabet.charsPerChunk; i++) {
                chunk <<= this.alphabet.bitsPerChar;
                if (charIdx + i < chars.length) {
                    chunk |= this.alphabet.decode(chars.charAt(charIdx + charsProcessed++));
                }
            }
            const minOffset = this.alphabet.bytesPerChunk * 8 - charsProcessed * this.alphabet.bitsPerChar;
            for (let offset = (this.alphabet.bytesPerChunk - 1) * 8; offset >= minOffset; offset -= 8) {
                target[bytesWritten++] = (chunk >>> offset) & 0xFF;
            }
        }
        return bytesWritten;
    }

  omitPadding(): BaseEncoding {
    return (this.paddingChar === null) ? this : this.newInstance(this.alphabet, null);
  }

  withPadChar(padChar: string): BaseEncoding {
    if (8 % this.alphabet.bitsPerChar === 0 || (this.paddingChar !== null && this.paddingChar === padChar)) {
      return this;
    } else {
      return this.newInstance(this.alphabet, padChar);
    }
  }

  withSeparator(separator: string, afterEveryChars: number): BaseEncoding {
      checkArgument(afterEveryChars > 0, "Cannot add a separator after every %s chars", afterEveryChars);
      for (let i = 0; i < separator.length; i++) {
          checkArgument(!this.alphabet.matches(separator.charAt(i)), "Separator (%s) cannot contain alphabet characters", separator);
      }
      if (this.paddingChar !== null) {
          checkArgument(separator.indexOf(this.paddingChar) < 0, "Separator (%s) cannot contain padding character", separator);
      }
      return new SeparatedBaseEncoding(this, separator, afterEveryChars);
  }
  
  upperCase(): BaseEncoding {
    if (this.upperCaseEncoding === null) {
        const upper = this.alphabet.upperCase();
        this.upperCaseEncoding = (upper === this.alphabet) ? this : this.newInstance(upper, this.paddingChar);
    }
    return this.upperCaseEncoding;
  }

  lowerCase(): BaseEncoding {
    if (this.lowerCaseEncoding === null) {
      const lower = this.alphabet.lowerCase();
      this.lowerCaseEncoding = (lower === this.alphabet) ? this : this.newInstance(lower, this.paddingChar);
    }
    return this.lowerCaseEncoding;
  }

  ignoreCase(): BaseEncoding {
    if (this.ignoreCaseEncoding === null) {
        const ignore = this.alphabet.ignoreCaseVersion();
        this.ignoreCaseEncoding = (ignore === this.alphabet) ? this : this.newInstance(ignore, this.paddingChar);
    }
    return this.ignoreCaseEncoding;
  }

  newInstance(alphabet: Alphabet, paddingChar: string | null): BaseEncoding {
    return new StandardBaseEncoding(alphabet, paddingChar);
  }
  
  toString(): string {
    let builder = "BaseEncoding.";
    builder += this.alphabet.toString();
    if (8 % this.alphabet.bitsPerChar !== 0) {
      if (this.paddingChar === null) {
        builder += ".omitPadding()";
      } else {
        builder += `.withPadChar('${this.paddingChar}')`;
      }
    }
    return builder;
  }
}

class Base16Encoding extends StandardBaseEncoding {
  private readonly encoding: string[] = new Array(512);

  constructor(name: string, alphabetChars: string) {
    super(new Alphabet(name, alphabetChars.split('')), undefined);
    checkArgument(this.alphabet.getCharsLength() === 16);
    for (let i = 0; i < 256; ++i) {
      this.encoding[i] = this.alphabet.encode(i >>> 4);
      this.encoding[i | 0x100] = this.alphabet.encode(i & 0xF);
    }
  }

  encodeTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number) {
    checkNotNull(target);
    checkPositionIndexes(off, off + len, bytes.length);
    for (let i = 0; i < len; ++i) {
      const b = bytes[off + i] & 0xFF;
      target.append(this.encoding[b]);
      target.append(this.encoding[b | 0x100]);
    }
  }

  decodeTo(target: Uint8Array, chars: string): number {
    checkNotNull(target);
    // Pad with leading zero if length is odd
    if (chars.length % 2 === 1) {
      chars = '0' + chars;
    }
    let bytesWritten = 0;
    for (let i = 0; i < chars.length; i += 2) {
      const decoded = (this.alphabet.decode(chars.charAt(i)) << 4) | this.alphabet.decode(chars.charAt(i + 1));
      target[bytesWritten++] = decoded;
    }
    return bytesWritten;
  }

  newInstance(alphabet: Alphabet, paddingChar: string | null): BaseEncoding {
    return new Base16Encoding(alphabet.name, alphabet.getCharsString());
  }
}

class Base64Encoding extends StandardBaseEncoding {
    constructor(name: string, alphabetChars: string, paddingChar: string | null) {
        super(new Alphabet(name, alphabetChars.split('')), paddingChar);
        checkArgument(this.alphabet.getCharsLength() === 64);
    }

    encodeTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number) {
        checkNotNull(target);
        checkPositionIndexes(off, off + len, bytes.length);
        let i = off;
        for (let remaining = len; remaining >= 3; remaining -= 3) {
            const chunk = ((bytes[i++] & 0xFF) << 16) | ((bytes[i++] & 0xFF) << 8) | (bytes[i++] & 0xFF);
            target.append(this.alphabet.encode(chunk >>> 18));
            target.append(this.alphabet.encode((chunk >>> 12) & 0x3F));
            target.append(this.alphabet.encode((chunk >>> 6) & 0x3F));
            target.append(this.alphabet.encode(chunk & 0x3F));
        }
        if (i < off + len) {
            this.encodeChunkTo(target, bytes, i, off + len - i);
        }
    }

    decodeTo(target: Uint8Array, chars: string): number {
        checkNotNull(target);
        chars = this.trimTrailingPadding(chars);
        if (!this.alphabet.isValidPaddingStartPosition(chars.length)) {
            throw new DecodingException("Invalid input length " + chars.length);
        }
        let bytesWritten = 0;
        let i = 0;
        while(i < chars.length) {
            let chunk = this.alphabet.decode(chars.charAt(i++)) << 18;
            chunk |= this.alphabet.decode(chars.charAt(i++)) << 12;
            target[bytesWritten++] = (chunk >>> 16);
            if (i < chars.length) {
                chunk |= this.alphabet.decode(chars.charAt(i++)) << 6;
                target[bytesWritten++] = (chunk >>> 8) & 0xFF;
                if (i < chars.length) {
                    chunk |= this.alphabet.decode(chars.charAt(i++));
                    target[bytesWritten++] = chunk & 0xFF;
                }
            }
        }
        return bytesWritten;
    }

    newInstance(alphabet: Alphabet, paddingChar: string | null): BaseEncoding {
        return new Base64Encoding(alphabet.name, alphabet.getCharsString(), paddingChar);
    }
}

class SeparatedBaseEncoding extends BaseEncoding {
    private readonly delegate: BaseEncoding;
    private readonly separator: string;
    private readonly afterEveryChars: number;

    constructor(delegate: BaseEncoding, separator: string, afterEveryChars: number) {
        super();
        this.delegate = checkNotNull(delegate);
        this.separator = checkNotNull(separator);
        this.afterEveryChars = afterEveryChars;
        checkArgument(afterEveryChars > 0, "Cannot add a separator after every %s chars", afterEveryChars);
    }
    
    // Helper to create a separating appender
    private separatingAppendable(delegate: { append(s: string): any }, separator: string, afterEveryChars: number) {
        let charsUntilSeparator = afterEveryChars;
        return {
            append: (c: string): any => {
                for(let i = 0; i < c.length; i++) {
                    if (charsUntilSeparator == 0) {
                        delegate.append(separator);
                        charsUntilSeparator = afterEveryChars;
                    }
                    delegate.append(c.charAt(i));
                    charsUntilSeparator--;
                }
                return this;
            }
        };
    }

    trimTrailingPadding(chars: string): string {
        return this.delegate.trimTrailingPadding(chars);
    }

    maxEncodedSize(bytes: number): number {
        const unseparatedSize = this.delegate.maxEncodedSize(bytes);
        return unseparatedSize + this.separator.length * IntMath.divide(Math.max(0, unseparatedSize - 1), this.afterEveryChars, 'FLOOR');
    }

    encodeTo(target: { append(s: string): any; }, bytes: Uint8Array, off: number, len: number) {
        this.delegate.encodeTo(this.separatingAppendable(target, this.separator, this.afterEveryChars), bytes, off, len);
    }

    maxDecodedSize(chars: number): number {
        return this.delegate.maxDecodedSize(chars);
    }

    canDecode(chars: string): boolean {
        const builder = new BaseEncoding.StringBuilder();
        for (let i = 0; i < chars.length; i++) {
            const c = chars.charAt(i);
            if (this.separator.indexOf(c) < 0) {
                builder.append(c);
            }
        }
        return this.delegate.canDecode(builder.toString());
    }

    decodeTo(target: Uint8Array, chars: string): number {
        const stripped = new BaseEncoding.StringBuilder();
        for (let i = 0; i < chars.length; i++) {
            const c = chars.charAt(i);
            if (this.separator.indexOf(c) < 0) {
                stripped.append(c);
            }
        }
        return this.delegate.decodeTo(target, stripped.toString());
    }
    
    omitPadding(): BaseEncoding {
        return this.delegate.omitPadding().withSeparator(this.separator, this.afterEveryChars);
    }
    
    withPadChar(padChar: string): BaseEncoding {
        return this.delegate.withPadChar(padChar).withSeparator(this.separator, this.afterEveryChars);
    }
    
    withSeparator(separator: string, afterEveryChars: number): BaseEncoding {
        throw new Error("Already have a separator");
    }
    
    upperCase(): BaseEncoding {
        return this.delegate.upperCase().withSeparator(this.separator, this.afterEveryChars);
    }
    
    lowerCase(): BaseEncoding {
        return this.delegate.lowerCase().withSeparator(this.separator, this.afterEveryChars);
    }

    ignoreCase(): BaseEncoding {
        return this.delegate.ignoreCase().withSeparator(this.separator, this.afterEveryChars);
    }
    
    toString(): string {
        return `${this.delegate.toString()}.withSeparator("${this.separator}", ${this.afterEveryChars})`;
    }
}
