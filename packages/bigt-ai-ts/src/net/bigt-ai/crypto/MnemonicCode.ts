import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { MnemonicException } from './MnemonicException';
import bip39Wordlist from './bip39-wordlist';

/**
 * A MnemonicCode object may be used to convert between binary seed values and
 * lists of words per <a href="https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki">the BIP 39
 * specification</a>
 */
export class MnemonicCode {
    private wordList: string[];

    private static readonly BIP39_ENGLISH_RESOURCE_NAME = "mnemonic/wordlist/english.txt";
    private static readonly BIP39_ENGLISH_SHA256 = "ad90bf3beb7b0eb7e5acd74727dc0da96e0a280a258354e7293fb7e211ac03db";

    /** UNIX time for when the BIP39 standard was finalised. This can be used as a default seed birthday. */
    public static BIP39_STANDARDISATION_TIME_SECS = 1381276800;

    private static readonly PBKDF2_ROUNDS = 2048;

    public static INSTANCE: MnemonicCode;

    // Removed hardcoded wordlist - now using official BIP39 wordlist
    // imported from './bip39-wordlist'

    constructor() {
        this.wordList = bip39Wordlist;
    }

    /**
     * Gets the word list this code uses.
     */
    public getWordList(): string[] {
        return this.wordList;
    }

    /**
     * Convert mnemonic word list to seed.
     */
    public static async toSeed(words: string[], passphrase: string): Promise<Uint8Array> {
        const pass = words.join(" ");
        const salt = "mnemonic" + passphrase;

        // PBKDF2 with HMAC-SHA512, 2048 rounds, 64 bytes output
        const seed = await pbkdf2(sha512, new TextEncoder().encode(pass), new TextEncoder().encode(salt), {
            c: MnemonicCode.PBKDF2_ROUNDS,
            dkLen: 64,
        });
        return seed;
    }

    /**
     * Convert mnemonic word list to original entropy value.
     */
    public async toEntropy(words: string[]): Promise<Uint8Array> {
        if (words.length % 3 > 0)
            throw new MnemonicException.MnemonicLengthException("Word list size must be multiple of three words.");

        if (words.length === 0)
            throw new MnemonicException.MnemonicLengthException("Word list is empty.");

        // Look up all the words in the list and construct the concatenated binary string.
        const concatBits = words.map(word => {
            const ndx = this.wordList.indexOf(word);
            if (ndx < 0)
                throw new MnemonicException.MnemonicWordException(word);
            return ndx.toString(2).padStart(11, '0');
        }).join('');
        
        const checksumLengthBits = concatBits.length / 33;
        const entropyLengthBits = concatBits.length - checksumLengthBits;

        const entropy = new Uint8Array(entropyLengthBits / 8);
        for (let i = 0; i < entropy.length; i++) {
            const byteString = concatBits.substring(i * 8, (i + 1) * 8);
            entropy[i] = parseInt(byteString, 2);
        }

        // Take the digest of the entropy.
        const hash = sha256(entropy);
        const hashBits = MnemonicCode.bytesToBits(hash);

        // Check all the checksum bits.
        const checksum = concatBits.substring(entropyLengthBits);
        if (hashBits.substring(0, checksumLengthBits) !== checksum) {
            throw new MnemonicException.MnemonicChecksumException();
        }

        return entropy;
    }

    /**
     * Convert entropy data to mnemonic word list.
     */
    public toMnemonic(entropy: Uint8Array): string[] {
        if (entropy.length % 4 > 0) {
            throw new MnemonicException.MnemonicLengthException("Entropy length not multiple of 32 bits.");
        }

        if (entropy.length === 0) {
            throw new MnemonicException.MnemonicLengthException("Entropy is empty.");
        }

        const entropyBits = MnemonicCode.bytesToBits(entropy);
        const checksumLengthBits = entropyBits.length / 32;
        const hash = sha256(entropy);
        const hashBits = MnemonicCode.bytesToBits(hash);
        const checksumBits = hashBits.substring(0, checksumLengthBits);

        const concatBits = checksumBits + entropyBits;

        const words: string[] = [];
        const nwords = concatBits.length / 11;
        for (let i = 0; i < nwords; ++i) {
            const index = parseInt(concatBits.substring(i * 11, (i + 1) * 11), 2);
            words.push(this.wordList[index]);
        }
            
        return words;        
    }

    /**
     * Check to see if a mnemonic word list is valid.
     */
    public async check(words: string[]): Promise<void> {
        await this.toEntropy(words);
    }

    private static bytesToBits(data: Uint8Array): string {
        let bits = '';
        for (let i = 0; i < data.length; i++) {
            bits += data[i].toString(2).padStart(8, '0');
        }
        return bits;
    }
}

MnemonicCode.INSTANCE = new MnemonicCode();
