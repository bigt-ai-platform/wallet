import type { L1ChainConfig } from '@/types/api';

/**
 * Canonical display names for the two built-in L1 chains. A layer label names
 * the chain's **role** (order vs prediction), not the network it happens to run
 * on ("Main" / "Test" / "Local"), so the same layer reads the same on mainnet,
 * testnet and a local harness.
 */
const CANONICAL_L1_NAMES: Record<string, string> = {
  ordermatch: 'order',
  prediction: 'Prediction',
};

/**
 * Layer label used by the balance/blocks screens: `L0`, `L1-order`,
 * `L1-Prediction`. `layer` is the 1-based index into the configured L1 chain
 * list (0 = Settlement). A custom chain keeps its configured name, then its
 * chain id, then the numeric index as fallbacks.
 */
export function layerLabel(layer: number, chains: readonly L1ChainConfig[]): string {
  if (!Number.isFinite(layer) || layer <= 0) return 'L0';
  const chain = chains[layer - 1];
  const id = (chain?.chainId ?? '').trim().toLowerCase();
  const base =
    CANONICAL_L1_NAMES[id] ||
    chain?.name?.trim() ||
    chain?.chainId?.trim() ||
    String(layer);
  return `L1-${base}`;
}
