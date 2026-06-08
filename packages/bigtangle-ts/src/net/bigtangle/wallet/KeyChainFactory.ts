// Correctly import the Key message interface from the generated wallet file and alias it.
import { Key as ProtoKey } from '../wallet/Protos';
import { DeterministicSeed } from './DeterministicSeed';
import { KeyCrypter } from '../crypto/KeyCrypter';
import { DeterministicKeyChain } from './DeterministicKeyChain';
import { DeterministicKey } from '../crypto/DeterministicKey';

/**
 * A factory interface for creating KeyChain instances while de-serializing a wallet.
 * This allows for different KeyChain implementations to be used without changing the
 * wallet loading logic.
 */
export interface KeyChainFactory {
    /**
     * Creates a standard, spendable keychain from a seed.
     *
     * @param key The protobuf message for the root key of the chain.
     * @param firstSubKey The protobuf message for the first child key (e.g., the parent of the external subchain).
     * @param seed The deterministic seed for this chain.
     * @param crypter The key crypter for handling encrypted data.
     * @param isMarried Whether this keychain is the leading chain in a multi-signature (married) setup.
     * @returns A new DeterministicKeyChain instance.
     */
    makeKeyChain(
        key: ProtoKey,
        firstSubKey: ProtoKey,
        seed: DeterministicSeed,
        crypter: KeyCrypter,
        isMarried: boolean
    ): DeterministicKeyChain;

    /**
     * Creates a "watching" keychain, which can track balances and transactions
     * but cannot sign them. This is created from an extended public key.
     *
     * Note: `isMarried` and `isFollowingKey` should not be true at the same time.
     *
     * @param key The protobuf message for the account-level key.
     * @param firstSubKey The protobuf message for the first child key.
     * @param accountKey The deterministic key representing the account's extended public key.
     * @param isFollowingKey Whether this keychain is a "following" chain in a married setup.
     * @param isMarried Whether this keychain is the leading chain in a married setup.
     * @returns A new, watching-only DeterministicKeyChain instance.
     */
    makeWatchingKeyChain(
        key: ProtoKey,
        firstSubKey: ProtoKey,
        accountKey: DeterministicKey,
        isFollowingKey: boolean,
        isMarried: boolean
    ): DeterministicKeyChain;
}