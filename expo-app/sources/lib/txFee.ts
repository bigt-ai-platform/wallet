import { BC_DECIMALS, formatTokenAmount } from './tokenformat';

/**
 * The chain fee a Layer-0 spend pays, in raw **BIG** units
 * (`Coin.FEE_DEFAULT` = 1000 raw). It is always denominated in BIG, whatever
 * token is being sent:
 *
 *  - sending BIG: the fee comes out of the same transaction (the sender is
 *    debited `amount + fee`, the recipient gets `amount`);
 *  - sending another token: the main transfer is fee-free and a separate BIG
 *    fee transaction burns the fee (Java `Wallet.payToList` →
 *    `feeTransaction`), so the wallet needs a little BIG as well.
 *
 * L1 order chains are fee-free (`payOnLayer1` calls `wallet.setFee(false)`).
 */
export const TX_FEE_RAW = 1000n;

/** Raw BIG fee for a spend on `layer` (0 = Settlement, ≥1 = an L1 chain). */
export function txFeeRaw(layer: number): bigint {
  return layer === 0 ? TX_FEE_RAW : 0n;
}

/** The fee in BIG display units for a spend on `layer` (e.g. "0.001"). */
export function txFeeAmount(layer: number): string {
  return formatTokenAmount(txFeeRaw(layer), BC_DECIMALS);
}
