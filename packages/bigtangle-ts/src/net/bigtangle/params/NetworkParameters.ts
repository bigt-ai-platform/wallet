/**
 * Abstract class representing network parameters for different blockchain networks.
 */
import { BitcoinSerializer } from "../core/BitcoinSerializer";

export abstract class NetworkParameters {
  // Static constants
  static readonly HEADER_SIZE = 168;
  /*
    80 + // Standard Bitcoin block header size
    32 + // additional branch prev block
    2 * 4 + // time and difftarget from int to long (8 bytes each instead of 4)
    8 + // sequence (lastMiningReward) long
    20 + // miner address
    4 + // blockType
    8; // height
    */
  static readonly BLOCK_VERSION_GENESIS = 1;
  static readonly MAX_DEFAULT_BLOCK_SIZE = 1000000;
  static readonly MAX_REWARD_BLOCK_SIZE = 1000000;
  static readonly ALLOWED_TIME_DRIFT = 2 * 60 * 60; // 2 hours
  static readonly MAX_BLOCK_SIGOPS = 20000;
  static readonly ORDER_TIMEOUT_MAX = 30 * 24 * 60 * 60; // 30 days in seconds
  static readonly BIGTANGLE_TOKENID_STRING = "bc";
  public static getBIGTANGLE_TOKENID() {
    // Simple hex decoder to avoid circular dependencies
    const tokenString = this.BIGTANGLE_TOKENID_STRING;
    const bytes = [];
    for (let i = 0; i < tokenString.length; i += 2) {
      bytes.push(parseInt(tokenString.substr(i, 2), 16));
    }
    return new Uint8Array(bytes);
  }
  static readonly BIGTANGLE_TOKENNAME = "BigTangle";
  static readonly BIGTANGLE_DECIMAL = 6;
  static readonly ID_MAINNET = "main";
  static readonly ID_UNITTESTNET = "test";
  static readonly BigtangleCoinTotal = BigInt(1000000000000);

  abstract getP2SHHeader(): number;
  abstract getAddressHeader(): number;
  abstract getAcceptableAddressCodes(): number[];
  abstract getId(): string;

  // Additional required methods
  abstract getMaxTarget(): bigint;

  abstract getProtocolVersionNum(version: number): number;
  abstract getBip32HeaderPub(): number;
  abstract getBip32HeaderPriv(): number;
  abstract getDumpedPrivateKeyHeader(): number;
  abstract serverSeeds(): string[];
  abstract getGenesisPub(): string;
  abstract getPacketMagic(): number;

  public getSerializer(parseRetain: boolean): BitcoinSerializer {
    return new BitcoinSerializer(this, parseRetain);
  }

  private defaultSerializer: BitcoinSerializer | null = null;

  /**
   * Return the default serializer for this network. This is a shared serializer.
   */
  public getDefaultSerializer(): BitcoinSerializer {
    // Construct a default serializer if we don't have one
    if (this.defaultSerializer === null) {
      // Don't grab a lock unless we absolutely need it
      // In TypeScript/JavaScript we don't need synchronization as it's single-threaded
      // Now we have a lock, double check there's still no serializer
      // and create one if so.
      if (this.defaultSerializer === null) {
        // As the serializers are intended to be immutable, creating
        // two due to a race condition should not be a problem,
        // however to be safe we ensure only one exists for each network.
        this.defaultSerializer = this.getSerializer(false);
      }
    }
    return this.defaultSerializer;
  }
}
