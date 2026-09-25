import { Block } from './Block';
import { Transaction } from './Transaction';
import { TransactionOutput } from './TransactionOutput';
import { NetworkParameters } from '../params/NetworkParameters';
import { Sha256Hash } from './Sha256Hash';
import { BlockType } from './BlockType';
import { Coin } from './Coin';
import { Address } from './Address';
import { readFileSync } from 'node:fs';

import { PQKey } from '../crypto/pq/PQKey';
import { KeyBundle } from '../crypto/pq/KeyBundle';
import { KeyBundleEntry } from '../crypto/pq/KeyBundle';
import { PQConstants } from '../crypto/pq/PQConstants';
import { Utils } from './Utils';
import { Script } from '../script/Script';
import { ScriptBuilder } from '../script/ScriptBuilder';
import { TransactionInput } from './TransactionInput';
import { RewardInfo } from './RewardInfo';

export class UtilGeneseBlock {
  public static readonly GENESIS_CSV_PROPERTY = "bigtangle.genesis.csv";
  public static readonly GENESIS_CSV_ENV = "BIGTANGLE_GENESIS_CSV";

  public static add(
    params: NetworkParameters,
    amount: bigint,
    account: string,
    coinbase: Transaction
  ): void {
    // amount, many public keys
    const list: string[] = account.split(",");
    const base: Coin = new Coin(amount, NetworkParameters.getBIGTANGLE_TOKENID());
    const keys: PQKey[] = [];
    for (const s of list) {
      const pubBytes = Utils.HEX.decode(s.trim());
      // Legacy EC pubkeys (0x02/0x03/0x04 prefix, 33-65 bytes) - wrap in KeyBundle
      if (
        pubBytes.length > 0 &&
        (pubBytes[0] === 0x02 || pubBytes[0] === 0x03 || pubBytes[0] === 0x04)
      ) {
        const bundle = new KeyBundle([
          new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pubBytes),
        ]);
        keys.push(PQKey.fromPublicOnlyBytes(bundle.serialize()));
      } else {
        keys.push(PQKey.fromPrefixedPublicKey(pubBytes));
      }
    }
    if (keys.length <= 1) {
      coinbase.addOutput(
        new TransactionOutput(
          params,
          coinbase,
          base,
          ScriptBuilder.createOutputScript(
            PQKey.fromPublicOnly(keys[0].getPubKey())
          ).getProgram()
        )
      );
    } else {
      const scriptPubKey: Script = ScriptBuilder.createMultiSigOutputScript(
        keys.length - 1,
        keys
      );
      coinbase.addOutput(new TransactionOutput(params, coinbase, base, scriptPubKey.getProgram()));
    }
  }

  public static createGenesis(params: NetworkParameters): Block;
  public static createGenesis(params: NetworkParameters, distribution: GenesisOutput[]): Block;
  public static createGenesis(params: NetworkParameters, distribution?: GenesisOutput[]): Block {
    if (distribution === undefined) {
      let csv: string | undefined;
      if (typeof process !== "undefined" && typeof process.env !== "undefined")
        csv = process.env[UtilGeneseBlock.GENESIS_CSV_PROPERTY] ?? process.env[UtilGeneseBlock.GENESIS_CSV_ENV];
      if (csv != null && csv.trim().length > 0)
        return UtilGeneseBlock.createGenesisFromList(params, UtilGeneseBlock.loadGenesisOutputsFromCsv(csv.trim()));
      return UtilGeneseBlock.createGenesisFromList(params, null);
    }
    return UtilGeneseBlock.createGenesisFromList(params, distribution);
  }

  public static createGenesisFromList(params: NetworkParameters, distribution: GenesisOutput[] | null): Block {
    const genesisBlock: Block = Block.setBlock7(
      params,
      Sha256Hash.ZERO_HASH,
      Sha256Hash.ZERO_HASH,
      BlockType.BLOCKTYPE_INITIAL,
      0,
      0,
      0
    );
    genesisBlock.setTime(1532896109);

    const coinbase: Transaction = new Transaction(params);
    const inputBuilder: ScriptBuilder = new ScriptBuilder();
    inputBuilder.data(new TextEncoder().encode(params.getChainId()));
    coinbase.addInput(
      TransactionInput.fromScriptBytes(params, coinbase, inputBuilder.build().getProgram())
    );

    const rewardInfo: RewardInfo = new RewardInfo(
      Sha256Hash.ZERO_HASH,
      0,
      new Set<Sha256Hash>(),
      0
    );

    coinbase.setData(rewardInfo.toByteArray());

    if (distribution != null && distribution.length > 0) {
      for (const out of distribution) UtilGeneseBlock.addOutput(params, out, coinbase);
    } else if (params.genesisMintsBIG()) {
      UtilGeneseBlock.add(params, NetworkParameters.BigtangleCoinTotal, params.getGenesisPub(), coinbase);
    }
    genesisBlock.addTransaction(coinbase);
    genesisBlock.setHeight(0);
    return genesisBlock;
  }

  private static addOutput(params: NetworkParameters, out: GenesisOutput, coinbase: Transaction): void {
    const base = new Coin(out.amount, NetworkParameters.getBIGTANGLE_TOKENID());
    let script: Script;
    if (out.pubkeyHex != null) {
      const pubBytes = Utils.HEX.decode(out.pubkeyHex.trim());
      let key: PQKey;
      if (
        pubBytes.length > 0 &&
        (pubBytes[0] === 0x02 || pubBytes[0] === 0x03 || pubBytes[0] === 0x04)
      ) {
        const bundle = new KeyBundle([
          new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, pubBytes),
        ]);
        key = PQKey.fromPublicOnlyBytes(bundle.serialize());
      } else {
        key = PQKey.fromPrefixedPublicKey(pubBytes);
      }
      script = ScriptBuilder.createOutputScript(key);
    } else {
      script = ScriptBuilder.createOutputScript(Address.fromBase58(params, out.address as string));
    }
    coinbase.addOutput(new TransactionOutput(params, coinbase, base, script.getProgram()));
  }

  public static loadGenesisOutputsFromCsv(path: string): GenesisOutput[] {
    const outputs: GenesisOutput[] = [];
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error("Failed to load genesis distribution CSV: " + path);
    }
    let header = true;
    for (let rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (header) {
        header = false;
        continue;
      }
      const cols = line.split(',');
      const address = (cols[0] ?? '').trim();
      const pubkey = (cols[1] ?? '').trim();
      const value = BigInt((cols[2] ?? '0').trim() === '' ? '0' : (cols[2] ?? '0').trim());
      if (pubkey.length > 0)
        outputs.push(GenesisOutput.toPubkey(value, pubkey));
      else
        outputs.push(GenesisOutput.toAddress(value, address));
    }
    return outputs;
  }
}

export class GenesisOutput {
  readonly amount: bigint;
  readonly address: string | null;
  readonly pubkeyHex: string | null;

  constructor(amount: bigint, address: string | null, pubkeyHex: string | null) {
    this.amount = amount;
    this.address = address;
    this.pubkeyHex = pubkeyHex;
  }

  static toAddress(amount: bigint, base58Address: string): GenesisOutput {
    return new GenesisOutput(amount, base58Address, null);
  }

  static toPubkey(amount: bigint, pubkeyHex: string): GenesisOutput {
    return new GenesisOutput(amount, null, pubkeyHex);
  }
}
