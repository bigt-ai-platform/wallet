import { Base58, ECKey, PQKey, Sha256Hash, Utils } from 'bigtangle-ts';

/**
 * App-local P2P identity helpers.
 *
 * The wallet's P2P identity is its PQ (ML-DSA-87) key. The engine authenticates
 * each request with a did:key over that key, and a signature over the sha256 of
 * the canonical (sorted top-level keys) JSON body. This mirrors
 * `packages/did` + `services/p2p-engine/src/sign.ts` but is implemented with
 * `bigtangle-ts` only, because importing the `did` package pulls in
 * `node:crypto` (Metro-hostile).
 */
const MULTICODEC_MLDSA87 = 0x300001;
const MULTICODEC_SECP256K1 = 0xe7;
const DID_PREFIX = 'did:key:z';

function encodeUvarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/** Rebuild the wallet's PQ key from its stored private key hex. The wallet
 *  stores `PQKey.getPrivateKeyHex()` (the serialized bundle), so this must use
 *  `fromPrivateKey` — exactly as `WalletHelper` reconstructs it — not the
 *  seed-based `fromPrivateKeyHex`. */
export function pqKeyFromPrivateHex(privateKeyHex: string): PQKey {
  return PQKey.fromPrivateKey(Utils.HEX.decode(privateKeyHex));
}

/**
 * The P2P signing identity for a wallet key.
 *
 * Every P2P request is signed with ML-DSA and authenticated as a `did:key`, so
 * the wallet needs a PQ key. A legacy secp256k1 wallet (`keyType === 'EC'`,
 * imported from an old `.wallet`) has no PQ key of its own — but its 32-byte
 * private key *is* a valid ML-DSA seed. Deriving the P2P identity from it is
 * deterministic (the same wallet always gets the same did:key) and keeps the
 * EC address as the receive/refund address; the did is only the engine identity
 * and the party key share of an escrow vault.
 *
 * Without this, `identity` stayed null for every legacy wallet and the create
 * form rendered "unlock your wallet first" even while the wallet was unlocked.
 *
 * Returns null only when the stored key cannot be reconstructed.
 */
export function p2pIdentityFromWallet(
  privateKeyHex: string | undefined,
  keyType?: 'PQ' | 'EC',
): { key: PQKey; did: string; fundsKey?: ECKey } | null {
  const hex = (privateKeyHex ?? '').trim();
  if (!hex) return null;
  try {
    // PQ wallets store the serialized private-key bundle (fromPrivateKey);
    // EC wallets store the 32-byte secp256k1 secret, which fromPrivateKeyHex
    // expands as the ML-DSA seed.
    const key = keyType === 'EC'
      ? PQKey.fromPrivateKeyHex(hex)
      : pqKeyFromPrivateHex(hex);
    // A legacy EC wallet's funds live at its EC address, not at the derived
    // ML-DSA DID's address. `signedBody` proves that address to the engine so
    // its advisory balance check reads the right key (docs/p2p.md §11). A key
    // that cannot back a proof simply leaves the old DID-key behavior.
    let fundsKey: ECKey | undefined;
    if (keyType === 'EC') {
      try { fundsKey = ECKey.fromPrivate(Utils.HEX.decode(hex), true); } catch { fundsKey = undefined; }
    }
    return { key, did: pqDidFromKey(key), ...(fundsKey ? { fundsKey } : {}) };
  } catch {
    return null;
  }
}

/** did:key over a compressed secp256k1 pubkey — the classic keycode the
 *  engine's funds-proof verifier accepts. Implemented locally (like the PQ
 *  form above) because importing the `did` package pulls in `node:crypto`. */
export function ecDidFromKey(key: ECKey): string {
  const mc = encodeUvarint(MULTICODEC_SECP256K1);
  const pub = key.getPubKeyBytes();
  const combined = new Uint8Array(mc.length + pub.length);
  combined.set(mc, 0);
  combined.set(pub, mc.length);
  return `${DID_PREFIX}${Base58.encode(combined)}`;
}

/** did:key over the PQ public key (codec 0x300001, base58btc) — matches the engine. */
export function pqDidFromKey(key: PQKey): string {
  const mc = encodeUvarint(MULTICODEC_MLDSA87);
  const pub = key.getPrefixedPublicKeyBytes();
  const combined = new Uint8Array(mc.length + pub.length);
  combined.set(mc, 0);
  combined.set(pub, mc.length);
  return `${DID_PREFIX}${Base58.encode(combined)}`;
}

/** Sorted top-level keys — the canonical form the engine verifies. */
export function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/** Deep canonical JSON — sorted keys at every level, `sig`/`sigScheme`
 *  stripped — the exact bytes `record-sig` digests engine-side. */
export function canonicalRecordJson(record: object): string {
  return JSON.stringify(canonicalize(record));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (k === 'sig' || k === 'sigScheme') continue;
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Author-sign a `social.*` record: sha256 over the canonical record JSON,
 *  PQ-signed — the exact shape `verifyRecordSig` checks (docs/p2p.md §11). */
export function signP2pRecord(
  key: PQKey,
  record: object,
): { sig: string; sigScheme: 'mldsa' } {
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonicalRecordJson(record)));
  const bundle = key.sign(Sha256Hash.wrap(digest));
  return { sig: Utils.HEX.encode(bundle.serialize()), sigScheme: 'mldsa' };
}

/** Fresh seller order id (`ord-<16hex>`, the engine's P2P_ORDER_ID_RE). */
export function newOrderId(): string {
  return `ord-${randomHex(8)}`;
}

/**
 * Short display form of a did:key (`head…tail`). A full PQ did is ~2.6 KB, so the
 * order/swap cards show this and pair it with a copy action that carries the
 * exact full value.
 */
export function shortDid(did: string, head = 22, tail = 6): string {
  const d = (did ?? '').trim();
  if (!d) return '';
  return d.length <= head + tail + 1 ? d : `${d.slice(0, head)}…${d.slice(-tail)}`;
}

/** Sign the sha256 digest of the canonical payload, hex-encoded SignatureBundle. */
export function signP2pPayload(key: PQKey, payload: Record<string, unknown>): string {
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonicalJson(payload)));
  const bundle = key.sign(Sha256Hash.wrap(digest));
  return Utils.HEX.encode(bundle.serialize());
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Utils.HEX.encode(arr);
}

/**
 * Attach `did`/`nonce`/`timestamp` and a PQ signature, the exact shape the
 * engine's `validateSignedRequest` expects.
 *
 * `fundsKey` (legacy EC wallets only) additionally attaches a proof of the
 * wallet's real chain address: `fundsDid` + `fundsSignature`. The main
 * signature covers both fields, so they cannot be changed in flight; the
 * engine verifies the EC signature over the canonical payload (docs/p2p.md
 * §11) before trusting it for the advisory balance check.
 */
export function signedBody(
  key: PQKey,
  did: string,
  fields: Record<string, unknown>,
  now: number = Date.now(),
  fundsKey?: ECKey | null,
): Record<string, unknown> {
  const base = { ...fields, requestMethod: 'POST', did, nonce: randomHex(16), timestamp: now };
  if (!fundsKey) return { ...base, signature: signP2pPayload(key, base) };
  const fundsDid = ecDidFromKey(fundsKey);
  const fundsDigest = Sha256Hash.hash(new TextEncoder().encode(canonicalJson({ ...base, fundsDid })));
  const fundsSignature = Utils.HEX.encode(fundsKey.sign(Sha256Hash.wrap(fundsDigest)).toCompact());
  const payload = { ...base, fundsDid, fundsSignature };
  return { ...payload, signature: signP2pPayload(key, payload) };
}
