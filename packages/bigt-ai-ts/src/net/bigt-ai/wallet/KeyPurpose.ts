/**
 * <p>This enum is used to describe the purpose of a key in a key chain. It can be used to know how to retrieve
 * keys from a key chain, and also to signal to the wallet what a key is for when a key is added.
 * </p>
 */
export enum KeyPurpose {
    /** For normal receiving of payments. */
    RECEIVE_FUNDS,
    /** For change from payments you sent. */
    CHANGE,
    /** For authenticating something; not yet used. */
    AUTHENTICATION,
    /** For refunding payments, e.g. when a broadcast transaction is not confirmed. */
    REFUND,
    /** For keys that are not part of a BIP44 keychain. */
    USER_DEFINED
}
