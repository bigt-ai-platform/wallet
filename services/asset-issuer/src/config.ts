/**
 * Asset configuration for the issuer service.
 *
 * Must stay in step with `expo-app/sources/lib/externalAssets.ts` (`id`,
 * `decimals`, enabled). The service does not import the app registry: this is
 * the server-side authority, and the app validates whatever the catalog returns.
 *
 * `externalDecimals` is the scale the *external* asset arrives in (ETH 18,
 * USDC 6, gold bars 6…). `l1Decimals` is always 6 for a listed asset — the
 * `long` order fields make 18 unusable and the wallet uses one constant.
 * Conversion dust is tracked, never dropped.
 */

/** How value enters custody for this asset. */
export type DepositKind = 'bank' | 'vault' | 'evm' | 'l1';

export interface AssetConfig {
  assetId: string;
  symbol: string;
  /** Funding rail the wallet must show for a deposit. */
  depositKind: DepositKind;
  /** Free-text funding instructions (bank account, vault, custody address). */
  depositInstructions?: string;
  /** For `depositKind: 'evm'`: the custody address to send to. */
  depositAddress?: string;
  /** Memo/tag for chains that need one (not EVM; kept for shared rails). */
  depositMemo?: string;
  /** Prefix of the payment reference the user must include. */
  referencePrefix?: string;
  /** For ERC-20 deposits: the token contract to watch. */
  contract?: string;
  /** For ERC-20 deposits: the custody address that receives them. */
  custodyAddress?: string;
  /**
   * `static` (default): everyone sends to `depositAddress`/`custodyAddress`.
   * `per-user`: `/deposit-address` derives a BIP32 address per L1 account, so
   * an exchange-origin deposit can be attributed without a memo (ERC-20 has
   * none). Requires an xpub in `depositXpub` or the service's `DEPOSIT_XPUB`.
   */
  depositAddressMode?: 'static' | 'per-user';
  /** Account-level xpub used for per-user derivation (public material only). */
  depositXpub?: string;
  /** Non-hardened path below the xpub; default `0` (external chain). */
  depositXpubPath?: string;
  /** `tokenid` on L1-order (the issuer public key hex), once issued. */
  l1TokenId?: string;
  /** Multi-sign signer public keys authorized for reissuance. */
  signers?: string[];
  /** Signature threshold for reissuance (default 1). */
  signnumber?: number;
  /** L1 address that receives redemption transfers (base58). */
  redemptionAddress?: string;
  /** Decimals of the external observation (chain units / bank units). */
  externalDecimals: number;
  /** Decimals of the L1 token. Always 6 for a listed asset. */
  l1Decimals: number;
  /** Hard cap on total L1 supply, smallest L1 units. */
  maxSupplyRaw: bigint;
  /** Per-operation mint cap, smallest L1 units. */
  maxMintRaw: bigint;
  enabled: boolean;
}

export const DEFAULT_ASSETS: AssetConfig[] = [
  {
    assetId: 'hkd',
    symbol: 'HKD',
    depositKind: 'bank',
    depositInstructions: 'Bank transfer to the segregated HKD reserve account (details issued out of band); include the reference below.',
    referencePrefix: 'HKD',
    externalDecimals: 6,
    l1Decimals: 6,
    maxSupplyRaw: 10n ** 18n,
    maxMintRaw: 10n ** 12n,
    enabled: true,
  },
  {
    assetId: 'usd',
    symbol: 'USD',
    depositKind: 'bank',
    depositInstructions: 'Bank transfer to the segregated USD reserve account (details issued out of band); include the reference below.',
    referencePrefix: 'USD',
    externalDecimals: 6,
    l1Decimals: 6,
    maxSupplyRaw: 10n ** 18n,
    maxMintRaw: 10n ** 12n,
    enabled: true,
  },
  {
    assetId: 'gold',
    symbol: 'GOLD',
    depositKind: 'vault',
    depositInstructions: 'Allocated-bar allocation at the vault (details issued out of band); include the reference below.',
    referencePrefix: 'GOLD',
    externalDecimals: 6,
    l1Decimals: 6,
    maxSupplyRaw: 10n ** 15n,
    maxMintRaw: 10n ** 12n,
    enabled: true,
  },
  {
    assetId: 'eth',
    symbol: 'ETH',
    depositKind: 'evm',
    depositInstructions: 'Send ETH to the custody address below on Ethereum mainnet; the token is minted after finality.',
    referencePrefix: 'ETH',
    externalDecimals: 18,
    l1Decimals: 6,
    maxSupplyRaw: 10n ** 12n,
    maxMintRaw: 10n ** 11n,
    enabled: true,
  },
];

export function assetsFromEnv(raw: string | undefined): AssetConfig[] {
  if (!raw) return DEFAULT_ASSETS;
  const parsed = JSON.parse(raw) as Array<Partial<AssetConfig> & { assetId: string }>;
  if (!Array.isArray(parsed)) throw new Error('ASSETS_JSON must be an array');
  return parsed.map((entry) => {
    if (!entry.assetId) throw new Error('ASSETS_JSON entry without assetId');
    if (entry.depositAddressMode && entry.depositAddressMode !== 'static' && entry.depositAddressMode !== 'per-user') {
      // A typo must not silently fall back to a shared address (misattribution).
      throw new Error(`ASSETS_JSON ${entry.assetId}: depositAddressMode must be static or per-user`);
    }
    return {
      assetId: entry.assetId,
      symbol: entry.symbol ?? entry.assetId.toUpperCase(),
      depositKind: entry.depositKind ?? 'bank',
      ...(entry.depositInstructions ? { depositInstructions: entry.depositInstructions } : {}),
      ...(entry.depositAddress ? { depositAddress: entry.depositAddress } : {}),
      ...(entry.depositMemo ? { depositMemo: entry.depositMemo } : {}),
      ...(entry.referencePrefix ? { referencePrefix: entry.referencePrefix } : {}),
      ...(entry.contract ? { contract: entry.contract } : {}),
      ...(entry.custodyAddress ? { custodyAddress: entry.custodyAddress } : {}),
      ...(entry.depositAddressMode ? { depositAddressMode: entry.depositAddressMode } : {}),
      ...(entry.depositXpub ? { depositXpub: entry.depositXpub } : {}),
      ...(entry.depositXpubPath ? { depositXpubPath: entry.depositXpubPath } : {}),
      ...(entry.l1TokenId ? { l1TokenId: entry.l1TokenId } : {}),
      ...(entry.signers ? { signers: entry.signers } : {}),
      ...(entry.signnumber ? { signnumber: entry.signnumber } : {}),
      ...(entry.redemptionAddress ? { redemptionAddress: entry.redemptionAddress } : {}),
      externalDecimals: entry.externalDecimals ?? 6,
      l1Decimals: entry.l1Decimals ?? 6,
      maxSupplyRaw: BigInt(entry.maxSupplyRaw ?? '0'),
      maxMintRaw: BigInt(entry.maxMintRaw ?? '0'),
      enabled: entry.enabled ?? true,
    };
  });
}

export function findAssetConfig(assets: AssetConfig[], assetId: string): AssetConfig | undefined {
  const key = assetId.trim().toLowerCase();
  return assets.find((a) => a.assetId.toLowerCase() === key);
}
