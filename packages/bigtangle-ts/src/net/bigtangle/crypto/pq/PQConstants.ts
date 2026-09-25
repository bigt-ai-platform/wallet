export const PQConstants = {
  ALG_ML_DSA_87: 1,
  ALG_SLH_DSA_SHA2_256S: 2,

  SUITE_CAT5_DUAL_1: 1,
  SUITE_ML_DSA_ONLY: 2,

  ML_DSA_87_PUBKEY_BYTES: 2560,
  ML_DSA_87_SEED_BYTES: 32,
  SLH_DSA_256S_PUBKEY_BYTES: 64,
  SLH_DSA_256S_SEED_BYTES: 32,

  MLDSA_SIG_DOMAIN: "MLDSA-SIG-DOMAIN",
  SLHDSA_SIG_DOMAIN: "SLHDSA-SIG-DOMAIN",
  TX_DOMAIN: "BIGTANGLE-PQ-TX-v1",
  MERKLE_DOMAIN: "BIGTANGLE-MERKLE-v1",
  HKDF_SALT: "BIGTANGLE-PQ-v1",
  HKDF_INFO_WALLET: "wallet root",

  ADDRESS_VERSION: 1,
  ADDRESS_HASH_BYTES: 32,
  NETWORK_MAINNET: 0,
  NETWORK_TESTNET: 1,

  BUNDLE_VERSION: 1,
  TX_PQ_VERSION: 2,

  NEVER_ACTIVATE: -1,
  DUAL_SUITE_DEFAULT_ACTIVATION_HEIGHT: -1,
  DUAL_ACTIVATION_PROPERTY: "net.bigtangle.pq.dualActivationHeight",

  dualActivationHeightFromProperty(): number {
    let v: string | undefined;
    if (typeof process !== "undefined" && typeof process.env !== "undefined")
      v = process.env[PQConstants.DUAL_ACTIVATION_PROPERTY];
    if (v == null || v.trim().length === 0) return PQConstants.DUAL_SUITE_DEFAULT_ACTIVATION_HEIGHT;
    const h = Number.parseInt(v.trim(), 10);
    if (Number.isNaN(h) || h < 0) return PQConstants.DUAL_SUITE_DEFAULT_ACTIVATION_HEIGHT;
    return h;
  },
} as const;
