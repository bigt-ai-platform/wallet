import { Block } from './Block';
import { Transaction } from './Transaction';
import { TransactionOutput } from './TransactionOutput';
import { NetworkParameters } from '../params/NetworkParameters';
import { Sha256Hash } from './Sha256Hash';
import { BlockType } from './BlockType';
import { Coin } from './Coin';

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

  public static createGenesis(params: NetworkParameters): Block {
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

    if (params.genesisMintsBIG()) {
      UtilGeneseBlock.add(params, NetworkParameters.BigtangleCoinTotal, params.getGenesisPub(), coinbase);
    }
    genesisBlock.addTransaction(coinbase);
    genesisBlock.setHeight(0);
    return genesisBlock;
  }
}
