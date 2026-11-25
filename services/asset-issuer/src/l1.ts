/**
 * L1 (bigt-ai) adapters for the issuer.
 *
 * Two seams:
 *
 * - `WalletLike` — the narrow slice of `bigt-ai-ts` this service uses. Tests
 *   inject a fake; production gets the real wallet from `createBigtAiWallet`.
 * - `BigtAiL1Minter` — reissues an asset's token and pays it to the holder.
 *
 * **Reissuance mints to the issuer wallet, then pays the holder.** The chain's
 * token-creation output is addressed by public key, and the issuer only knows
 * the holder's base58 address, so a two-step mint is the only correct path. The
 * intermediate balance is the issuer's own float, never credited to anyone.
 *
 * This binding has **not** run against a live chain in this repository: the
 * first execution must be on Test with `ALLOW_LIVE_L1=1`, one asset, one unit.
 * The wrapper logic (ordering, guards, mapping) is covered by unit tests.
 */

import type { AssetConfig } from './config.js';
import type { Operation } from './domain.js';
import type { SignerContext, L1Minter, Treasury } from './executor.js';
import type { ChainClient, DepositObservation, RedemptionObservation } from './watcher.js';

export interface L1TokenOutput {
  blockHash: string;
  txHash: string;
  index: number;
  valueRaw: bigint;
  tokenId: string;
  address: string;
  confirmed: boolean;
}

/** The only `bigt-ai-ts` surface this service depends on. */
export interface WalletLike {
  /** Reissue `amountRaw` of `tokenId` to a fresh wallet-internal output. */
  reissue(asset: AssetConfig, amountRaw: string): Promise<{ blockHash: string }>;
  /** Submit one multi-signature round for the token (no-op under threshold 1). */
  multiSign(tokenId: string): Promise<void>;
  /** Signatures the node still wants before the token block is solid. */
  pendingSigns(tokenId: string): Promise<number>;
  /** Pay `amountRaw` of `tokenId` to a base58 address. */
  pay(tokenId: string, toAddress: string, amountRaw: string): Promise<{ txHash: string }>;
  /** Currently spendable outputs of `tokenId` held by this wallet. */
  tokenOutputs(tokenId: string): Promise<L1TokenOutput[]>;
}

export interface L1MinterOptions {
  wallet: WalletLike;
  assets: AssetConfig[];
  /** When false, `mint` throws instead of signing (dry-run / staging). */
  live: boolean;
  /** Delay between multi-sign attempts while a token block is not solid yet. */
  signaturePollMs?: number;
}

export class BigtAiL1Minter implements L1Minter {
  constructor(private readonly options: L1MinterOptions) {}

  async mint(
    assetId: string,
    account: string,
    l1Raw: string,
    _context?: SignerContext,
  ): Promise<{ txHash: string }> {
    const asset = this.options.assets.find((a) => a.assetId === assetId);
    if (!asset) throw new Error(`unknown asset: ${assetId}`);
    if (!asset.l1TokenId) {
      throw new Error(`asset ${assetId} has no l1TokenId configured; run the issuance ceremony first`);
    }
    if (!account) throw new Error('mint requires a destination account');
    if (BigInt(l1Raw) <= BigInt(0)) throw new Error('mint amount must be > 0');
    if (!this.options.live) throw new Error('L1 minting is disabled (set ALLOW_LIVE_L1=1 on Test)');

    await this.options.wallet.reissue(asset, l1Raw);
    // A token block is only solid once the node has every signature it asks for
    // (the issuer signs at creation; the chain's domain key is the second one).
    // Paying before that leaves the mint stuck, so drain first — proven on the
    // Java test infra: without this the token index never moved.
    await this.drainSignatures(asset.l1TokenId);
    return this.options.wallet.pay(asset.l1TokenId, account, l1Raw);
  }

  private async drainSignatures(tokenId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await this.options.wallet.pendingSigns(tokenId)) === 0) return;
      await this.options.wallet.multiSign(tokenId);
      await sleep(this.options.signaturePollMs ?? 1000);
    }
    const pending = await this.options.wallet.pendingSigns(tokenId);
    if (pending !== 0) {
      throw new Error(`token ${tokenId.slice(0, 12)} still needs ${pending} signature(s)`);
    }
  }
}

/** Injectable for tests; the default keeps the loop short. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Redemptions arrive as ordinary L1 transfers to the issuer's redemption
 * address. We deliberately do **not** derive them from the issuer's own token
 * balance: that balance also holds freshly minted float, and using it as a
 * redemption signal would release external value for our own stock.
 *
 * **Diagnostics only.** The live pipeline no longer wires this source: a bare
 * L1 transfer has no destination and cannot authorize a release, and recording
 * it would consume the `(chain, txHash, logIndex)` a signed intent needs.
 * Redemptions are verified by `BigtAiRedemptionVerifier` instead.
 */
export class BigtAiRedemptionSource {
  constructor(
    private readonly wallet: WalletLike,
    private readonly assets: AssetConfig[],
    private readonly chain = 'l1-order',
  ) {}

  async redemptions(_fromBlock: number): Promise<RedemptionObservation[]> {
    const out: RedemptionObservation[] = [];
    for (const asset of this.assets) {
      if (!asset.enabled || !asset.l1TokenId || !asset.redemptionAddress) continue;
      for (const output of await this.wallet.tokenOutputs(asset.l1TokenId)) {
        // Defensive: a wallet that returns mixed outputs must not turn another
        // token's balance into a redemption.
        if (output.tokenId !== asset.l1TokenId) continue;
        if (!output.confirmed) continue;
        if (output.address !== asset.redemptionAddress) continue;
        if (output.valueRaw <= BigInt(0)) continue;
        out.push({
          assetId: asset.assetId,
          account: output.address,
          l1Raw: output.valueRaw.toString(),
          chain: this.chain,
          txHash: output.txHash,
          logIndex: output.index,
          blockNumber: 0,
        });
      }
    }
    return out;
  }
}

/**
 * Custody release is intentionally not implemented here: it needs the
 * HSM/MPC-backed treasury key and an approval flow, neither of which belongs in
 * this process. Failing loudly beats a half-signed release.
 */
export class RefusingTreasury implements Treasury {
  async release(
    assetId: string,
    _account: string,
    _destination: string,
    _externalRaw: string,
    _context?: SignerContext,
  ): Promise<{ txHash: string }> {
    throw new Error(
      `treasury release for ${assetId} is not configured: wire the HSM/MPC custody adapter before enabling redeem`,
    );
  }
}

export type RedemptionCheck = 'ok' | 'pending' | 'invalid';

/**
 * Verifies that a redemption is backed by a real, finalized L1 return.
 *
 * The issuer cannot pay out on its own holder-balance record alone: after a
 * spot trade the seller keeps that credit while the buyer holds the tokens, so
 * releasing on the credit would drain the reserve without retiring any supply.
 * A release therefore needs an L1 output paid to `redemptionAddress` for the
 * **exact** token and amount the intent names, and the operation's
 * `(chain, txHash, logIndex)` is unique, so one return authorizes one release.
 */
export class BigtAiRedemptionVerifier {
  constructor(
    private readonly wallet: WalletLike,
    private readonly assets: AssetConfig[],
  ) {}

  async check(operation: Operation, asset: AssetConfig): Promise<RedemptionCheck> {
    if (!operation.ref || operation.ref.chain !== 'l1-order') return 'invalid';
    if (!asset.l1TokenId || !asset.redemptionAddress) return 'invalid';
    const want = BigInt(operation.l1AmountRaw);
    if (want <= 0n) return 'invalid';

    const txHash = normalizeHash(operation.ref.txHash);
    const outputs = await this.wallet.tokenOutputs(asset.l1TokenId);
    const inTx = outputs.filter((output) => normalizeHash(output.txHash) === txHash);
    if (inTx.length === 0) {
      // The transaction may not be indexed by this node yet; the caller retries.
      return 'pending';
    }
    for (const output of inTx) {
      if (output.tokenId !== asset.l1TokenId) continue;
      if (output.address !== asset.redemptionAddress) continue;
      if (output.valueRaw !== want) continue;
      return output.confirmed ? 'ok' : 'pending';
    }
    return 'invalid';
  }

  async verify(operation: Operation, asset: AssetConfig): Promise<boolean> {
    return (await this.check(operation, asset)) === 'ok';
  }
}

function normalizeHash(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

/** Compose a `ChainClient` from the EVM deposit source plus L1 redemptions. */
export function composeChainClient(
  deposits: Pick<ChainClient, 'finalizedBlock' | 'deposits' | 'depositWindow'>,
  redemptions: Pick<ChainClient, 'redemptions'>,
): ChainClient {
  return {
    finalizedBlock: (chain: string) => deposits.finalizedBlock(chain),
    deposits: (fromBlock: number, toBlock?: number): Promise<DepositObservation[]> =>
      deposits.deposits(fromBlock, toBlock),
    redemptions: (fromBlock: number) => redemptions.redemptions(fromBlock),
    ...(deposits.depositWindow ? { depositWindow: deposits.depositWindow } : {}),
  };
}
