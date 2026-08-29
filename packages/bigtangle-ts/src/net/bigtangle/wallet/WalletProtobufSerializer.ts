/**
 * Serializes and de-serializes a wallet to a byte array containing the legacy
 * protocol-buffer format (see `wallet.proto` in the Java blockchain codebase).
 *
 * This is the TypeScript port of the (removed) Java
 * `net.bigtangle.wallet.WalletProtobufSerializer`, used to import old-format
 * `.wallet` files. Protocol buffers are a data interchange format developed by
 * Google with an efficient binary representation; conceptually they represent
 * data using (tag, length, value) tuples.
 *
 * The wallet message layout mirrors the removed `wallet.proto`:
 * <pre>
 * message Wallet {
 *   required string network_identifier = 1;
 *   optional bytes last_seen_block_hash = 2;
 *   repeated Key key = 3;
 *   optional EncryptionType encryption_type = 5;
 *   optional ScryptParameters encryption_parameters = 6;
 *   optional int32 version = 7;
 *   ...
 * }
 * </pre>
 */
import { Wallet } from "./Wallet";
import { KeyChainGroup } from "./KeyChainGroup";
import { KeyChainFactory } from "./KeyChainFactory";
import { DefaultKeyChainFactory } from "./DefaultKeyChainFactory";
import { UnreadableWalletException } from "./UnreadableWalletException";
import { NetworkParameters } from "../params/NetworkParameters";
import { MainNetParams } from "../params/MainNetParams";
import { TestParams } from "../params/TestParams";
import { KeyCrypterScrypt } from "../crypto/KeyCrypterScrypt";
import { Key as ProtoKey, KeyType, Wallet as ProtoWallet, WalletEncryptionType, EncryptedData as ProtoEncryptedData, ScryptParameters as ProtoScryptParameters, DeterministicKey as ProtoDeterministicKey } from "./Protos";
import {
  WireType,
  ProtoField,
  decodeProto,
  firstVarint,
  allVarints,
  firstBytes,
  firstString,
  firstMessage,
  repeatedMessages,
  concat,
  encodeVarintField,
  encodeLengthDelimitedField,
  encodeStringField,
  encodeMessageField,
} from "./Protobuf";

export class WalletProtobufSerializer {
  /**
   * Current version used for serializing wallets. A version higher than this
   * is considered to come from the future.
   */
  public static readonly CURRENT_WALLET_VERSION = 1;

  /** 1 MB */
  private static readonly WALLET_SIZE_LIMIT = 1024 * 1024;

  private keyChainFactory: KeyChainFactory;

  constructor(keyChainFactory?: KeyChainFactory) {
    this.keyChainFactory = keyChainFactory ?? new DefaultKeyChainFactory();
  }

  public setKeyChainFactory(keyChainFactory: KeyChainFactory): void {
    this.keyChainFactory = keyChainFactory;
  }

  /**
   * Formats the given wallet (keys) as a byte array in protocol buffer format.
   */
  public writeWallet(wallet: Wallet): Uint8Array {
    return WalletProtobufSerializer.encodeWallet(this.walletToProto(wallet));
  }

  /**
   * Converts the given wallet to the object representation of the protocol
   * buffers.
   */
  public walletToProto(wallet: Wallet): ProtoWallet {
    const builder: ProtoWallet = {
      network_identifier: wallet.getNetworkParameters().getId(),
      key: wallet.keyChainGroup.toProtobuf(),
      transaction: [],
      watched_script: [],
      extension: [],
      tags: [],
      transaction_signers: [],
    };

    const keyCrypter = wallet.getKeyCrypter();
    if (keyCrypter === null) {
      builder.encryption_type = WalletEncryptionType.UNENCRYPTED;
    } else {
      builder.encryption_type = WalletEncryptionType.ENCRYPTED_SCRYPT_AES;
      if (keyCrypter instanceof KeyCrypterScrypt) {
        const scryptParams = keyCrypter.getScryptParameters();
        builder.encryption_parameters = {
          salt: scryptParams.salt,
          n: scryptParams.N,
          r: scryptParams.r,
          p: scryptParams.p,
        };
      } else {
        throw new Error(
          "The wallet has encryption of type '" + keyCrypter.getUnderstoodEncryptionType() +
          "' but this WalletProtobufSerializer does not know how to persist this."
        );
      }
    }

    const version = wallet.getVersion();
    if (version > 0) {
      builder.version = version;
    }

    return builder;
  }

  /**
   * Loads wallet data from the given protocol-buffer byte array.
   *
   * @throws UnreadableWalletException on corrupt data, an unknown network
   *         identifier, a future wallet version, or missing key data.
   */
  public readWallet(input: Uint8Array): Wallet {
    const walletProto = WalletProtobufSerializer.parseToProto(input);
    if ((walletProto.version ?? WalletProtobufSerializer.CURRENT_WALLET_VERSION) > WalletProtobufSerializer.CURRENT_WALLET_VERSION) {
      throw new UnreadableWalletException.FutureVersion();
    }
    const paramsID = walletProto.network_identifier;
    const params = WalletProtobufSerializer.networkFromID(paramsID);
    if (params === null) {
      throw new UnreadableWalletException("Unknown network parameters ID " + paramsID);
    }
    return this.readWalletFromProto(params, walletProto);
  }

  /**
   * Loads wallet data from the given protocol buffer into a new Wallet.
   */
  public readWalletFromProto(params: NetworkParameters, walletProto: ProtoWallet): Wallet {
    let keyChainGroup: KeyChainGroup;
    if (walletProto.encryption_type === WalletEncryptionType.ENCRYPTED_SCRYPT_AES) {
      const encParams = walletProto.encryption_parameters;
      const crypter = new KeyCrypterScrypt({
        N: encParams?.n ?? 16384,
        r: encParams?.r ?? 8,
        p: encParams?.p ?? 1,
        salt: encParams?.salt ?? KeyCrypterScrypt.randomSalt(),
      });
      keyChainGroup = KeyChainGroup.fromProtobufEncrypted(params, walletProto.key, crypter, this.keyChainFactory);
    } else {
      keyChainGroup = KeyChainGroup.fromProtobufUnencrypted(params, walletProto.key, this.keyChainFactory);
    }
    const wallet = new Wallet(params, keyChainGroup);
    if (walletProto.version !== undefined) {
      wallet.setVersion(walletProto.version);
    }
    return wallet;
  }

  /**
   * Returns the loaded protocol buffer from the given byte array.
   */
  public static parseToProto(input: Uint8Array): ProtoWallet {
    if (input.length > WalletProtobufSerializer.WALLET_SIZE_LIMIT) {
      throw new UnreadableWalletException("Wallet exceeds size limit of " + WalletProtobufSerializer.WALLET_SIZE_LIMIT + " bytes");
    }
    return WalletProtobufSerializer.parseWallet(decodeProto(input));
  }

  /**
   * Cheap test to see if the byte array is a wallet. This checks for the
   * network_identifier (field 1) at the start of the stream.
   */
  public static isWallet(input: Uint8Array): boolean {
    try {
      const fields = decodeProto(input);
      const first = fields[0];
      if (!first || first.field !== 1 || first.wireType !== WireType.LENGTH_DELIMITED) {
        return false;
      }
      const network = firstString(fields, 1);
      return network !== undefined && WalletProtobufSerializer.networkFromID(network) !== null;
    } catch {
      return false;
    }
  }

  private static networkFromID(id: string): NetworkParameters | null {
    switch (id) {
      case "Mainnet":
      case NetworkParameters.ID_MAINNET:
        return MainNetParams.get();
      case "Test":
      case NetworkParameters.ID_UNITTESTNET:
        return TestParams.get();
      default:
        return null;
    }
  }

  private static parseWallet(fields: ProtoField[]): ProtoWallet {
    const wallet: ProtoWallet = {
      network_identifier: firstString(fields, 1) ?? "",
      key: repeatedMessages(fields, 3).map(WalletProtobufSerializer.parseKey),
      transaction: [],
      watched_script: [],
      extension: [],
      tags: [],
      transaction_signers: [],
    };

    const lastSeenBlockHash = firstBytes(fields, 2);
    if (lastSeenBlockHash !== undefined) wallet.last_seen_block_hash = lastSeenBlockHash;

    const encryptionType = firstVarint(fields, 5);
    if (encryptionType !== undefined) wallet.encryption_type = Number(encryptionType);

    const encryptionParameters = firstMessage(fields, 6);
    if (encryptionParameters !== undefined) wallet.encryption_parameters = WalletProtobufSerializer.parseScryptParameters(encryptionParameters);

    const version = firstVarint(fields, 7);
    if (version !== undefined) wallet.version = Number(version);

    const description = firstString(fields, 11);
    if (description !== undefined) wallet.description = description;

    const lastSeenBlockHeight = firstVarint(fields, 12);
    if (lastSeenBlockHeight !== undefined) wallet.last_seen_block_height = Number(lastSeenBlockHeight);

    const keyRotationTime = firstVarint(fields, 13);
    if (keyRotationTime !== undefined) wallet.key_rotation_time = Number(keyRotationTime);

    const lastSeenBlockTimeSecs = firstVarint(fields, 14);
    if (lastSeenBlockTimeSecs !== undefined) wallet.last_seen_block_time_secs = Number(lastSeenBlockTimeSecs);

    return wallet;
  }

  private static parseKey(fields: ProtoField[]): ProtoKey {
    const type = firstVarint(fields, 1);
    const key: ProtoKey = {
      type: type !== undefined ? (Number(type) as KeyType) : KeyType.ORIGINAL,
    };

    const secretBytes = firstBytes(fields, 2);
    if (secretBytes !== undefined) key.secret_bytes = secretBytes;

    const publicKey = firstBytes(fields, 3);
    if (publicKey !== undefined) key.public_key = publicKey;

    const label = firstString(fields, 4);
    if (label !== undefined) key.label = label;

    const creationTimestamp = firstVarint(fields, 5);
    if (creationTimestamp !== undefined) key.creation_timestamp = Number(creationTimestamp);

    const encryptedData = firstMessage(fields, 6);
    if (encryptedData !== undefined) key.encrypted_data = WalletProtobufSerializer.parseEncryptedData(encryptedData);

    const deterministicKey = firstMessage(fields, 7);
    if (deterministicKey !== undefined) key.deterministic_key = WalletProtobufSerializer.parseDeterministicKey(deterministicKey);

    const deterministicSeed = firstBytes(fields, 8);
    if (deterministicSeed !== undefined) key.deterministic_seed = deterministicSeed;

    const encryptedDeterministicSeed = firstMessage(fields, 9);
    if (encryptedDeterministicSeed !== undefined) {
      key.encrypted_deterministic_seed = WalletProtobufSerializer.parseEncryptedData(encryptedDeterministicSeed);
    }

    return key;
  }

  private static parseEncryptedData(fields: ProtoField[]): ProtoEncryptedData {
    return {
      initialisation_vector: firstBytes(fields, 1) ?? new Uint8Array(),
      encrypted_private_key: firstBytes(fields, 2) ?? new Uint8Array(),
    };
  }

  private static parseScryptParameters(fields: ProtoField[]): ProtoScryptParameters {
    const params: ProtoScryptParameters = { salt: firstBytes(fields, 1) ?? new Uint8Array() };
    const n = firstVarint(fields, 2);
    if (n !== undefined) params.n = Number(n);
    const r = firstVarint(fields, 3);
    if (r !== undefined) params.r = Number(r);
    const p = firstVarint(fields, 4);
    if (p !== undefined) params.p = Number(p);
    return params;
  }

  private static parseDeterministicKey(fields: ProtoField[]): ProtoDeterministicKey {
    const key: ProtoDeterministicKey = {
      chain_code: firstBytes(fields, 1) ?? new Uint8Array(),
      path: allVarints(fields, 2).map((v) => Number(v)),
    };
    const issuedSubkeys = firstVarint(fields, 3);
    if (issuedSubkeys !== undefined) key.issued_subkeys = Number(issuedSubkeys);
    const lookaheadSize = firstVarint(fields, 4);
    if (lookaheadSize !== undefined) key.lookahead_size = Number(lookaheadSize);
    const isFollowing = firstVarint(fields, 5);
    if (isFollowing !== undefined) key.isFollowing = isFollowing !== 0n;
    const sigsRequiredToSpend = firstVarint(fields, 6);
    if (sigsRequiredToSpend !== undefined) key.sigsRequiredToSpend = Number(sigsRequiredToSpend);
    return key;
  }

  private static encodeWallet(wallet: ProtoWallet): Uint8Array {
    const parts: Uint8Array[] = [];
    parts.push(encodeStringField(1, wallet.network_identifier));
    if (wallet.last_seen_block_hash !== undefined) {
      parts.push(encodeLengthDelimitedField(2, wallet.last_seen_block_hash));
    }
    for (const key of wallet.key) {
      parts.push(encodeMessageField(3, WalletProtobufSerializer.encodeKey(key)));
    }
    if (wallet.encryption_type !== undefined) {
      parts.push(encodeVarintField(5, wallet.encryption_type));
    }
    if (wallet.encryption_parameters !== undefined) {
      parts.push(encodeMessageField(6, WalletProtobufSerializer.encodeScryptParameters(wallet.encryption_parameters)));
    }
    if (wallet.version !== undefined) {
      parts.push(encodeVarintField(7, wallet.version));
    }
    if (wallet.description !== undefined) {
      parts.push(encodeStringField(11, wallet.description));
    }
    if (wallet.last_seen_block_height !== undefined) {
      parts.push(encodeVarintField(12, wallet.last_seen_block_height));
    }
    if (wallet.key_rotation_time !== undefined) {
      parts.push(encodeVarintField(13, wallet.key_rotation_time));
    }
    if (wallet.last_seen_block_time_secs !== undefined) {
      parts.push(encodeVarintField(14, wallet.last_seen_block_time_secs));
    }
    return concat(...parts);
  }

  private static encodeKey(key: ProtoKey): Uint8Array {
    const parts: Uint8Array[] = [];
    if (key.type !== undefined) parts.push(encodeVarintField(1, key.type));
    if (key.secret_bytes !== undefined) parts.push(encodeLengthDelimitedField(2, key.secret_bytes));
    if (key.public_key !== undefined) parts.push(encodeLengthDelimitedField(3, key.public_key));
    if (key.label !== undefined) parts.push(encodeStringField(4, key.label));
    if (key.creation_timestamp !== undefined) parts.push(encodeVarintField(5, key.creation_timestamp));
    if (key.encrypted_data !== undefined) {
      parts.push(encodeMessageField(6, WalletProtobufSerializer.encodeEncryptedData(key.encrypted_data)));
    }
    if (key.deterministic_key !== undefined) {
      parts.push(encodeMessageField(7, WalletProtobufSerializer.encodeDeterministicKey(key.deterministic_key)));
    }
    if (key.deterministic_seed !== undefined) parts.push(encodeLengthDelimitedField(8, key.deterministic_seed));
    if (key.encrypted_deterministic_seed !== undefined) {
      parts.push(encodeMessageField(9, WalletProtobufSerializer.encodeEncryptedData(key.encrypted_deterministic_seed)));
    }
    return concat(...parts);
  }

  private static encodeEncryptedData(data: ProtoEncryptedData): Uint8Array {
    return concat(
      encodeLengthDelimitedField(1, data.initialisation_vector),
      encodeLengthDelimitedField(2, data.encrypted_private_key),
    );
  }

  private static encodeScryptParameters(params: ProtoScryptParameters): Uint8Array {
    const parts: Uint8Array[] = [];
    if (params.salt !== undefined) parts.push(encodeLengthDelimitedField(1, params.salt));
    if (params.n !== undefined) parts.push(encodeVarintField(2, params.n));
    if (params.r !== undefined) parts.push(encodeVarintField(3, params.r));
    if (params.p !== undefined) parts.push(encodeVarintField(4, params.p));
    return concat(...parts);
  }

  private static encodeDeterministicKey(key: ProtoDeterministicKey): Uint8Array {
    const parts: Uint8Array[] = [];
    if (key.chain_code !== undefined) parts.push(encodeLengthDelimitedField(1, key.chain_code));
    for (const path of key.path) {
      parts.push(encodeVarintField(2, path));
    }
    if (key.issued_subkeys !== undefined) parts.push(encodeVarintField(3, key.issued_subkeys));
    if (key.lookahead_size !== undefined) parts.push(encodeVarintField(4, key.lookahead_size));
    if (key.isFollowing !== undefined) parts.push(encodeVarintField(5, key.isFollowing ? 1 : 0));
    if (key.sigsRequiredToSpend !== undefined) parts.push(encodeVarintField(6, key.sigsRequiredToSpend));
    return concat(...parts);
  }
}
