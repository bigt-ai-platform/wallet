
// Curve parameters for secp256k1
// The curve order n is a well-known constant
const CURVE_N_HEX = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

// Export curve parameters
export const CURVE = {
    n: BigInt(`0x${CURVE_N_HEX}`),
    // g is not directly used in this implementation, but keeping for compatibility
    g: null,
};

// HALF_CURVE_ORDER = CURVE.n / 2 (equivalent to shiftRight(1) in big-integer)
export const HALF_CURVE_ORDER = CURVE.n >> 1n;
