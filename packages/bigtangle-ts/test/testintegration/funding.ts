import { Buffer } from "buffer";
import { Address } from "../../src/net/bigtangle/core/Address";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { UTXO } from "../../src/net/bigtangle/core/UTXO";
import { Utils } from "../../src/net/bigtangle/core/Utils";
import { Wallet } from "../../src/net/bigtangle/wallet/Wallet";

// The /fundAddresses faucet was removed from the Java server (ReqCmd no longer
// declares it). The infra now funds ONLY the genesis wallet (ML-DSA-87 seed
// 0x01) with confirmed BIG via the genesis CSV on both L0 and L1. Every other
// key must be funded on-chain from that wallet, exactly like Java's
// RemoteTestBase.payBigTo does.
export const GENESIS_SEED = 0x01;
export const BC_TOKENID = NetworkParameters.BIGTANGLE_TOKENID_STRING;

export function genesisKey(): PQKey {
  return PQKey.fromMLDSA(new Uint8Array(32).fill(GENESIS_SEED));
}

export function genesisWallet(url: string): Wallet {
  const w = Wallet.fromKeysURL(TestParams.get(), [genesisKey()], url);
  return w;
}

export async function waitForConfirmedBalance(
  url: string,
  keys: PQKey[],
  tokenid: string = BC_TOKENID,
  maxWaitMs: number = 90000,
  checkIntervalMs: number = 2000
): Promise<UTXO> {
  const w = Wallet.fromKeysURL(TestParams.get(), keys, url);
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const candidates = await w.calculateAllSpendCandidates(null, false);
    for (const co of candidates) {
      const utxo = co.getUTXO();
      if (tokenid === utxo.getTokenId() && co.getValue().getValue() > BigInt(0)) {
        return utxo;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }
  throw new Error(
    `Timeout waiting for confirmed balance of token ${tokenid} after ${maxWaitMs}ms`
  );
}

/** Pay BIG from the genesis wallet to `key` via an on-chain transfer and wait for confirmation. */
export async function fundKey(
  url: string,
  key: PQKey,
  value: bigint = BigInt(10000000000)
): Promise<void> {
  const genesis = genesisWallet(url);
  const giveMoney = new Map<string, bigint>();
  giveMoney.set(Address.fromKey(TestParams.get(), key).toString(), value);
  const tokenidBytes = Buffer.from(Utils.HEX.decode(BC_TOKENID));
  await genesis.payToList(null, giveMoney, tokenidBytes, "fundKey");
  await waitForConfirmedBalance(url, [key]);
}

/** Fund every key in `w` from the genesis wallet. */
export async function fundWallet(url: string, w: Wallet): Promise<void> {
  for (const key of await w.walletKeys(null)) {
    await fundKey(url, key);
  }
}
