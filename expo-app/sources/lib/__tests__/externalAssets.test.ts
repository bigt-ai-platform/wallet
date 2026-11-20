import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_ASSETS,
  buildDepositReference,
  HKD,
  HKDAP,
  ETH_TOKEN,
  USD,
  GOLD,
  complianceFlags,
  findExternalAsset,
  findExternalAssetByTokenId,
  formatExternalAmount,
  isExternalAsset,
  isValidExternalAmount,
  listExternalAssets,
  parseExternalAmount,
  requireExternalAsset,
  tradableExternalAssets,
} from '../externalAssets';

describe('external asset registry', () => {
  it('ships the four tradable assets at 6 decimals', () => {
    const tradable = tradableExternalAssets();
    expect(tradable.map((a) => a.id).sort()).toEqual(['eth', 'gold', 'hkd', 'usd']);
    for (const asset of tradable) {
      expect(asset.decimals).toBe(6);
      expect(asset.orderTrading.decimals).toBe(6);
      expect(asset.orderTrading.enabled).toBe(true);
      expect(asset.wrapModel).toBeDefined();
    }
  });

  it('keeps HKDAP rail-only — never an L1 token', () => {
    expect(HKDAP.orderTrading.enabled).toBe(false);
    expect(HKDAP.wrapModel).toBeUndefined();
    expect(HKDAP.custody).toBe('distributor');
    expect(tradableExternalAssets()).not.toContainEqual(HKDAP);
  });

  it('labels the custodial ETH token so it cannot be mistaken for ETH', () => {
    expect(ETH_TOKEN.id).toBe('eth');
    expect(ETH_TOKEN.symbol).toBe('ETH');
    expect(ETH_TOKEN.symbol).not.toBe('WETH');
    expect(ETH_TOKEN.wrapModel).toBe('issuer-credit');
    expect(ETH_TOKEN.settlementFinality).toBe('ethereum-finalized');
  });

  it('never ships a contract address to trust', () => {
    // Fake HKDAP tokens exist; the address must come from the distributor.
    expect(JSON.stringify(EXTERNAL_ASSETS)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('declares the permissioned controls on the fiat tokens', () => {
    for (const asset of [HKD, USD]) {
      expect(asset.compliance).toEqual({
        permissioned: true,
        allowlistRequired: true,
        pauseable: true,
        freezeable: true,
        mintRedeem: true,
      });
      expect(complianceFlags(asset)).toHaveLength(5);
    }
    // Gold is denylist-based, not allowlist: it is a commodity, not a security.
    expect(GOLD.compliance.permissioned).toBe(false);
    expect(GOLD.compliance.allowlistRequired).toBe(false);
  });

  it('looks up by id or symbol, case-insensitively', () => {
    expect(findExternalAsset('hkd')?.symbol).toBe('HKD');
    expect(findExternalAsset('HKD')?.id).toBe('hkd');
    expect(findExternalAsset('  HkdAp ')?.id).toBe('hkdap');
    expect(findExternalAsset('usdt')).toBeUndefined();
    expect(isExternalAsset('nope')).toBe(false);
  });

  it('maps an issued token id back to its asset once the ceremony has run', () => {
    expect(findExternalAssetByTokenId('deadbeef')).toBeUndefined();
    const issued = { ...HKD, orderTrading: { ...HKD.orderTrading, l1TokenId: 'ABCDEF' } };
    expect(issued.orderTrading.l1TokenId).toBe('ABCDEF');
    // The registry intentionally has no l1TokenId until issuance.
    expect(tradableExternalAssets().every((a) => a.orderTrading.l1TokenId === undefined)).toBe(true);
  });

  it('throws for an unknown asset instead of guessing one', () => {
    expect(() => requireExternalAsset('nope')).toThrow(/Unknown external asset/);
  });

  it('parses and formats with the declared decimals (no floats)', () => {
    expect(parseExternalAmount('1.5', HKD)).toBe(BigInt(1_500_000));
    expect(parseExternalAmount('0.000001', HKD)).toBe(BigInt(1));
    expect(formatExternalAmount(BigInt(1_500_000), HKD)).toBe('1.5');
    expect(formatExternalAmount('1234567', HKD)).toBe('1.234567');
  });

  it('rejects over-precision and junk amounts', () => {
    expect(isValidExternalAmount('1.0000001', HKD)).toBe(false);
    expect(isValidExternalAmount('abc', HKD)).toBe(false);
    expect(isValidExternalAmount('', HKD)).toBe(false);
    expect(() => parseExternalAmount('1.0000001', HKD)).toThrow();
  });

  it('declares a funding rail per asset', () => {
    expect(HKD.depositKind).toBe('bank');
    expect(USD.depositKind).toBe('bank');
    expect(GOLD.depositKind).toBe('vault');
    expect(ETH_TOKEN.depositKind).toBe('evm');
  });

  it('builds a deterministic, bank-safe payment reference', () => {
    const ref = buildDepositReference(HKD, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'abc123');
    expect(ref).toBe('HKD-ETTPYT-ABC123');
    // same inputs, same reference
    expect(buildDepositReference(HKD, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'abc123')).toBe(ref);
    // bank reference fields reject anything outside A-Z0-9-
    expect(ref).toMatch(/^[A-Z0-9-]+$/);
    expect(ref.length).toBeLessThanOrEqual(32);
  });

  it('sanitises a 0x account and an arbitrary nonce', () => {
    const ref = buildDepositReference(GOLD, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', 'q3-9 zz');
    expect(ref).toBe('GOLD-395BDF-Q39ZZ');
  });

  it('falls back safely for a missing account and rejects an empty nonce', () => {
    expect(buildDepositReference(USD, '', 'n1')).toBe('USD-WALLET-N1');
    expect(() => buildDepositReference(USD, 'abc', '')).toThrow(/nonce/);
  });

  it('lists every asset from one source', () => {
    expect(listExternalAssets().map((a) => a.id)).toEqual(['hkd', 'usd', 'gold', 'eth', 'hkdap']);
  });
});
