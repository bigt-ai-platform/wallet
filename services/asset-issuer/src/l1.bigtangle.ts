/**
 * Concrete `bigtangle-ts` binding for the L1 seams.
 *
 * **Not verified against a live chain in this repository.** Every call below is
 * the same one the wallet's prediction flow uses (`createToken` with
 * `increment=true`, then `multiSign`, then `pay`), but the issuer's first run
 * must be on Test with one asset and one unit.
 *
 * Two operational facts this binding encodes:
 *
 * 1. **Mint is two steps** — reissue to the issuer wallet, then pay the holder.
 *    The chain addresses a token-creation output by public key, and the issuer
 *    only knows the holder's base58 address.
 * 2. **Redemptions are read from a dedicated address** — never from the issuer's
 *    total token balance, which also holds freshly minted float.
 */

import {
  Coin,
  MainNetParams,
  MemoInfo,
  MultiSignAddress,
  PQKey,
  TestParams,
  Token,
  TokenType,
  Wallet,
  type NetworkParameters,
} from 'bigtangle-ts';
import type { AssetConfig } from './config.js';
import type { L1TokenOutput, WalletLike } from './l1.js';

export interface BigtangleWalletOptions {
  /** Order-chain API base, e.g. https://ordereu1.bigtangle.org */
  url: string;
  /** `Test` selects the test network parameters; anything else is mainnet. */
  network?: 'Test' | 'Mainnet';
  /** M-of-N issuer key held by this process (HSM/MPC in production). */
  issuerKeyHex: string;
  chainId?: string;
}

export function createBigtangleWallet(options: BigtangleWalletOptions): WalletLike {
  const params: NetworkParameters = options.network === 'Test' ? new TestParams() : new MainNetParams();
  params.setChainId(options.chainId ?? 'ordermatch');
  const key = PQKey.fromPrivateKeyHex(options.issuerKeyHex);
  const wallet = Wallet.fromKeysURL(params, [key], options.url);
  let lastBlockHash = '';

  return {
    async reissue(asset: AssetConfig, amountRaw: string) {
      if (!asset.l1TokenId) throw new Error(`${asset.assetId} has no l1TokenId configured`);
      const token = new Token();
      token.setTokenid(asset.l1TokenId);
      token.setTokenname(asset.symbol);
      token.setDecimals(asset.l1Decimals);
      token.setAmount(BigInt(amountRaw));
      token.setTokenstop(false);
      token.setTokentype(TokenType.token);

      const signers = (asset.signers?.length ? asset.signers : [key.getPublicKeyAsHex()])
        .map((pub) => new MultiSignAddress(asset.l1TokenId as string, '', pub));

      const block = await wallet.createToken(key, '', true, token, signers, key.getPubKey(),
        new MemoInfo('asset-issuer'));
      lastBlockHash = (block as unknown as { getHashAsString?: () => string })?.getHashAsString?.() ?? '';
      return { blockHash: lastBlockHash };
    },

    async multiSign(tokenId: string) {
      // One round; a node that already has the threshold returns null.
      await wallet.multiSign(tokenId, key, null);
    },

    async pendingSigns(tokenId: string): Promise<number> {
      const res = await fetch(`${options.url.replace(/\/+$/, '')}/getTokenSignByTokenid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenid: tokenId }),
      });
      if (!res.ok) throw new Error(`getTokenSignByTokenid HTTP ${res.status}`);
      const body = (await res.json()) as { multiSignList?: unknown[] };
      return Array.isArray(body.multiSignList) ? body.multiSignList.length : 0;
    },

    async pay(tokenId: string, toAddress: string, amountRaw: string) {
      const tx = await wallet.pay(null, toAddress, new Coin(BigInt(amountRaw), tokenId),
        new MemoInfo('asset-mint'));
      const hash = Array.isArray(tx)
        ? (tx[0] as unknown as { getHashAsString?: () => string })?.getHashAsString?.()
        : (tx as unknown as { getHashAsString?: () => string } | null)?.getHashAsString?.();
      return { txHash: hash ?? '' };
    },

    async tokenOutputs(tokenId: string): Promise<L1TokenOutput[]> {
      const candidates = await wallet.calculateAllSpendCandidates(null, false);
      const out: L1TokenOutput[] = [];
      for (const candidate of candidates) {
        const utxo = (candidate as unknown as { getUTXO?: () => any }).getUTXO?.();
        if (!utxo || utxo.getTokenId() !== tokenId) continue;
        out.push({
          blockHash: utxo.getHashHex?.() ?? '',
          txHash: utxo.getTxHash()?.toString() ?? '',
          index: utxo.getIndex(),
          valueRaw: utxo.getValue().getValue(),
          tokenId,
          address: utxo.getAddress() ?? '',
          // Spend candidates are already confirmed by the node; the chain is
          // responsible for not reporting a reorgable output here.
          confirmed: true,
        });
      }
      return out;
    },
  };
}
