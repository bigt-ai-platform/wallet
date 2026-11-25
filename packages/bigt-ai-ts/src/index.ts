/**
 * Main entry point for the bigt-ai-ts library
 *
 * This library provides types and utilities for working with the Bigt-Ai blockchain protocol,
 * including core components like addresses, transactions, blocks, cryptographic functions, etc.
 */

// Core types
export { Address } from './net/bigt-ai/core/Address';
export { Block } from './net/bigt-ai/core/Block';
export { Coin } from './net/bigt-ai/core/Coin';
export { CoinConstants } from './net/bigt-ai/core/CoinConstants';
/** Legacy secp256k1 key. Prefer PQKey for new keys; ECKey is retained for legacy address compatibility. */
export { ECKey, KeyType } from './net/bigt-ai/core/ECKey';
export { ECPoint } from './net/bigt-ai/core/ECPoint';
export { Sha256Hash } from './net/bigt-ai/core/Sha256Hash';
export { Transaction } from './net/bigt-ai/core/Transaction';
export { BlockType } from './net/bigt-ai/core/BlockType';
export { TransactionInput } from './net/bigt-ai/core/TransactionInput';
export { TransactionOutput } from './net/bigt-ai/core/TransactionOutput';
export { TransactionOutPoint } from './net/bigt-ai/core/TransactionOutPoint';
export { UTXO } from './net/bigt-ai/core/UTXO';
export { Token } from './net/bigt-ai/core/Token';
export { Monetary } from './net/bigt-ai/core/Monetary';
export { BloomFilter } from './net/bigt-ai/core/BloomFilter';
export { PartialMerkleTree } from './net/bigt-ai/core/PartialMerkleTree';
export { VarInt } from './net/bigt-ai/core/VarInt';
export { Utils } from './net/bigt-ai/core/Utils';
export { BigIntegerConverter } from './net/bigt-ai/core/BigIntegerConverter';
/** @deprecated Use SignatureBundle instead */
export { ECDSASignature } from './net/bigt-ai/core/ECDSASignature';
export { SigHash } from './net/bigt-ai/core/SigHash';
export { VersionedChecksummedBytes } from './net/bigt-ai/core/VersionedChecksummedBytes';

// Network parameters
export { NetworkParameters } from './net/bigt-ai/params/NetworkParameters';

// Crypto utilities and serializers
export { BitcoinSerializer } from './net/bigt-ai/core/BitcoinSerializer';
export { UtilGeneseBlock } from './net/bigt-ai/core/UtilGeneseBlock';

// Wallet functionality
export { DumpedPrivateKey } from './net/bigt-ai/core/DumpedPrivateKey';

// Additional blockchain elements
export { SpentBlock } from './net/bigt-ai/core/SpentBlock';
export { SpentBlockData } from './net/bigt-ai/core/SpentBlockData';
export { Spent } from './net/bigt-ai/core/Spent';
export { TXReward } from './net/bigt-ai/core/TXReward';
export { RewardInfo } from './net/bigt-ai/core/RewardInfo';

// Multi-signature support
export { MultiSign } from './net/bigt-ai/core/MultiSign';
export { MultiSignAddress } from './net/bigt-ai/core/MultiSignAddress';
export { PayMultiSign } from './net/bigt-ai/core/PayMultiSign';
export { PayMultiSignAddress } from './net/bigt-ai/core/PayMultiSignAddress';
export { PayMultiSignExt } from './net/bigt-ai/core/PayMultiSignExt';

// Script types - exported AFTER all other modules to avoid circular dependencies
// Import Script class and register it with both ScriptHelper and ScriptBuilder
import { Script } from './net/bigt-ai/script/Script';
import { registerScriptClass } from './net/bigt-ai/script/ScriptHelper';
import { registerScriptForBuilder } from './net/bigt-ai/script/ScriptBuilder';

// Register Script class immediately after import - this enables ScriptHelper and ScriptBuilder to work
registerScriptClass(Script);
registerScriptForBuilder(Script);

export { Script };
export { ScriptBuilder } from './net/bigt-ai/script/ScriptBuilder';
export { ScriptChunk } from './net/bigt-ai/script/ScriptChunk';
export { ScriptHelper } from './net/bigt-ai/script/ScriptHelper';

export { PayMultiSignInfo } from './net/bigt-ai/core/PayMultiSignInfo';
export { TestParams } from './net/bigt-ai/params/TestParams';
export { MainNetParams } from './net/bigt-ai/params/MainNetParams';
export { Base58 } from './net/bigt-ai/utils/Base58';

// Wallet functionality
export { Wallet } from './net/bigt-ai/wallet/Wallet';
export { WalletProtobufSerializer } from './net/bigt-ai/wallet/WalletProtobufSerializer';
export { Escrow, escrowSpendAmount } from './net/bigt-ai/wallet/Escrow';
export type { EscrowRoles, EscrowSpendOptions } from './net/bigt-ai/wallet/Escrow';

// Crypto functionality
export { KeyCrypterScrypt } from './net/bigt-ai/crypto/KeyCrypterScrypt';

// Post-quantum cryptography
export { PQConstants } from './net/bigt-ai/crypto/pq/PQConstants';
export { PQKey } from './net/bigt-ai/crypto/pq/PQKey';
export { KeyBundle, KeyBundleEntry } from './net/bigt-ai/crypto/pq/KeyBundle';
export { SignatureBundle, SignatureBundleEntry } from './net/bigt-ai/crypto/pq/SignatureBundle';
export { PQAddress } from './net/bigt-ai/crypto/pq/PQAddress';
export { PQKeyDerivation } from './net/bigt-ai/crypto/pq/PQKeyDerivation';
export { PQScriptUtils } from './net/bigt-ai/crypto/pq/PQScriptUtils';
export { BcPQSignatureProvider, UnsupportedOperationException } from './net/bigt-ai/crypto/pq/PQSignatureProvider';
export type { PQKeyPair } from './net/bigt-ai/crypto/pq/PQSignatureProvider';
export { GenesisOutput } from './net/bigt-ai/core/UtilGeneseBlock';
export { BaseTaggableObject } from './net/bigt-ai/utils/BaseTaggableObject';

// DID and agent-to-agent communication
export { DidKey } from './net/bigt-ai/crypto/DidKey';
export type { DidDocument, DidVerificationMethod } from './net/bigt-ai/crypto/DidKey';
export { ECDH } from './net/bigt-ai/crypto/ECDH';
export type { ECDHEncryptedData } from './net/bigt-ai/crypto/ECDH';
export { ChallengeAuth } from './net/bigt-ai/crypto/ChallengeAuth';
export type { Challenge, ChallengeResponse } from './net/bigt-ai/crypto/ChallengeAuth';

// Peer discovery
export { PeerDiscoveryClient } from './net/bigt-ai/pool/server/PeerDiscoveryClient';
export { DnsDiscoveryResolver } from './net/bigt-ai/pool/server/DnsDiscoveryResolver';
export { ServerInfoClient } from './net/bigt-ai/pool/server/ServerInfoClient';
export type { ServerInfoListResponse } from './net/bigt-ai/pool/server/ServerInfoClient';
export { ServerInfo } from './net/bigt-ai/response/ServerInfo';
export type { PeerInfo, GetPeersResponse } from './net/bigt-ai/pool/server/NodeRecord';
export { MemoInfo } from './net/bigt-ai/core/MemoInfo';
export { OrderOpenInfo } from './net/bigt-ai/core/OrderOpenInfo';
export { Side } from './net/bigt-ai/core/Side';
export { FreeStandingTransactionOutput } from './net/bigt-ai/wallet/FreeStandingTransactionOutput';
export { TokenType } from './net/bigt-ai/core/TokenType';


// Prediction market (docs/prediction-market.md, l1-prediction-server)
export { KeyValue } from './net/bigt-ai/core/KeyValue';
export { TokenKeyValues } from './net/bigt-ai/core/TokenKeyValues';
export { ContractEventInfo } from './net/bigt-ai/core/ContractEventInfo';
export { ContractEventCancelInfo } from './net/bigt-ai/core/ContractEventCancelInfo';
export { PredictionAction, PredictionMarketConfig } from './net/bigt-ai/apps/prediction/PredictionMarket';
export type { PredictionConfigInput } from './net/bigt-ai/apps/prediction/PredictionMarket';
export { PredictionMarketOrders } from './net/bigt-ai/apps/prediction/PredictionMarketOrders';
export type { BookLevel, MarketOrderPlan } from './net/bigt-ai/apps/prediction/PredictionMarketOrders';
