/**
 * Main entry point for the bigtangle-ts library
 *
 * This library provides types and utilities for working with the Bigtangle blockchain protocol,
 * including core components like addresses, transactions, blocks, cryptographic functions, etc.
 */

// Core types
export { Address } from './net/bigtangle/core/Address';
export { Block } from './net/bigtangle/core/Block';
export { Coin } from './net/bigtangle/core/Coin';
export { CoinConstants } from './net/bigtangle/core/CoinConstants';
/** @deprecated Use PQKey instead */
export { ECKey } from './net/bigtangle/core/ECKey';
export { ECPoint } from './net/bigtangle/core/ECPoint';
export { Sha256Hash } from './net/bigtangle/core/Sha256Hash';
export { Transaction } from './net/bigtangle/core/Transaction';
export { TransactionInput } from './net/bigtangle/core/TransactionInput';
export { TransactionOutput } from './net/bigtangle/core/TransactionOutput';
export { TransactionOutPoint } from './net/bigtangle/core/TransactionOutPoint';
export { UTXO } from './net/bigtangle/core/UTXO';
export { Token } from './net/bigtangle/core/Token';
export { Monetary } from './net/bigtangle/core/Monetary';
export { BloomFilter } from './net/bigtangle/core/BloomFilter';
export { PartialMerkleTree } from './net/bigtangle/core/PartialMerkleTree';
export { VarInt } from './net/bigtangle/core/VarInt';
export { Utils } from './net/bigtangle/core/Utils';
export { BigIntegerConverter } from './net/bigtangle/core/BigIntegerConverter';
/** @deprecated Use SignatureBundle instead */
export { ECDSASignature } from './net/bigtangle/core/ECDSASignature';
export { SigHash } from './net/bigtangle/core/SigHash';
export { VersionedChecksummedBytes } from './net/bigtangle/core/VersionedChecksummedBytes';

// Network parameters
export { NetworkParameters } from './net/bigtangle/params/NetworkParameters';

// Crypto utilities and serializers
export { BitcoinSerializer } from './net/bigtangle/core/BitcoinSerializer';
export { UtilGeneseBlock } from './net/bigtangle/core/UtilGeneseBlock';

// Wallet functionality
export { DumpedPrivateKey } from './net/bigtangle/core/DumpedPrivateKey';

// Additional blockchain elements
export { SpentBlock } from './net/bigtangle/core/SpentBlock';
export { SpentBlockData } from './net/bigtangle/core/SpentBlockData';
export { Spent } from './net/bigtangle/core/Spent';
export { TXReward } from './net/bigtangle/core/TXReward';
export { RewardInfo } from './net/bigtangle/core/RewardInfo';

// Multi-signature support
export { MultiSign } from './net/bigtangle/core/MultiSign';
export { MultiSignAddress } from './net/bigtangle/core/MultiSignAddress';
export { PayMultiSign } from './net/bigtangle/core/PayMultiSign';
export { PayMultiSignAddress } from './net/bigtangle/core/PayMultiSignAddress';
export { PayMultiSignExt } from './net/bigtangle/core/PayMultiSignExt';

// Script types - exported AFTER all other modules to avoid circular dependencies
// Import Script class and register it with both ScriptHelper and ScriptBuilder
import { Script } from './net/bigtangle/script/Script';
import { registerScriptClass } from './net/bigtangle/script/ScriptHelper';
import { registerScriptForBuilder } from './net/bigtangle/script/ScriptBuilder';

// Register Script class immediately after import - this enables ScriptHelper and ScriptBuilder to work
registerScriptClass(Script);
registerScriptForBuilder(Script);

export { Script };
export { ScriptBuilder } from './net/bigtangle/script/ScriptBuilder';
export { ScriptChunk } from './net/bigtangle/script/ScriptChunk';
export { ScriptHelper } from './net/bigtangle/script/ScriptHelper';

export { PayMultiSignInfo } from './net/bigtangle/core/PayMultiSignInfo';
export { TestParams } from './net/bigtangle/params/TestParams';
export { MainNetParams } from './net/bigtangle/params/MainNetParams';
export { Base58 } from './net/bigtangle/utils/Base58';

// Wallet functionality
export { Wallet } from './net/bigtangle/wallet/Wallet';

// Crypto functionality
export { KeyCrypterScrypt } from './net/bigtangle/crypto/KeyCrypterScrypt';

// Post-quantum cryptography
export { PQConstants } from './net/bigtangle/crypto/pq/PQConstants';
export { PQKey } from './net/bigtangle/crypto/pq/PQKey';
export { KeyBundle, KeyBundleEntry } from './net/bigtangle/crypto/pq/KeyBundle';
export { SignatureBundle, SignatureBundleEntry } from './net/bigtangle/crypto/pq/SignatureBundle';
export { PQAddress } from './net/bigtangle/crypto/pq/PQAddress';
export { PQKeyDerivation } from './net/bigtangle/crypto/pq/PQKeyDerivation';

// DID and agent-to-agent communication
export { DidKey } from './net/bigtangle/crypto/DidKey';
export type { DidDocument, DidVerificationMethod } from './net/bigtangle/crypto/DidKey';
export { ECDH } from './net/bigtangle/crypto/ECDH';
export type { ECDHEncryptedData } from './net/bigtangle/crypto/ECDH';
export { ChallengeAuth } from './net/bigtangle/crypto/ChallengeAuth';
export type { Challenge, ChallengeResponse } from './net/bigtangle/crypto/ChallengeAuth';

