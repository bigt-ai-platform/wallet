-- P2P settlement engine store (docs/p2p.md).
--
-- Rebuildable projection: the durable audit seed is the signed social.p2p-swap
-- record on L1-SOCIAL; this Postgres schema can be replayed from those records.
-- `p2p_orders` is the signed limit-order intake; `p2p_swap_events` is the
-- append-only event log whose latest row per swap is the swap's current state.

CREATE TABLE IF NOT EXISTS p2p_orders (
  order_id      TEXT PRIMARY KEY,
  seller_did    TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'limit_sell',
  give_token    TEXT NOT NULL,
  give_amount   TEXT NOT NULL,
  give_chain    TEXT NOT NULL,
  want_currency TEXT NOT NULL,
  want_amount   TEXT NOT NULL,
  want_rail     TEXT NOT NULL,
  valid_until   BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  signature     TEXT NOT NULL,
  swap_id       TEXT,
  -- L1-SOCIAL txid of the seller-anchored social.p2p-order record (NULL for
  -- legacy engine-intake orders). Additive: main() ALTERs it in on boot.
  txid          TEXT,
  -- The engine escrow participant the order is pinned to (docs/p2p.md §26);
  -- NULL on legacy orders. Additive: ALTERed in on boot.
  engine_pubkey TEXT,
  -- Binance-style ad fields (docs/p2p.md): buy/bid receive address, per-order
  -- fiat min/max, payment window (minutes), free-text terms, and the crypto
  -- remaining after partial fills. Additive: ALTERed in on boot.
  buyer_receive_address TEXT,
  min_order     TEXT,
  max_order     TEXT,
  time_limit    INTEGER,
  remarks       TEXT,
  remaining_give TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_orders_open_idx ON p2p_orders (status, created_at DESC);

-- Watcher cursor (src/replay.ts): the last L1-SOCIAL block the chain-scan
-- projector applied. A single-row table; NULL/absent row = replay from genesis.
CREATE TABLE IF NOT EXISTS p2p_watch_cursor (
  id         BOOLEAN PRIMARY KEY DEFAULT true,
  block_hash TEXT NOT NULL,
  height     BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS p2p_swap_events (
  seq        BIGSERIAL PRIMARY KEY,
  swap_id    TEXT NOT NULL,
  event_seq  INTEGER NOT NULL,
  status     TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_did  TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  txid       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_swap_events_swap_idx ON p2p_swap_events (swap_id, event_seq);
CREATE UNIQUE INDEX IF NOT EXISTS p2p_swap_events_seq_uidx ON p2p_swap_events (swap_id, event_seq);

-- Fiat rails (docs/p2p.md §11): the seller's collection profile (PII — never
-- anchored, party-scoped reads only) and the buyer's payment proofs (receipt
-- bytes live here, never on the swap event or the chain).
CREATE TABLE IF NOT EXISTS p2p_payment_profiles (
  seller_did  TEXT NOT NULL,
  method      TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account     TEXT NOT NULL,
  bank_name   TEXT,
  qr          TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_did, method)
);

CREATE TABLE IF NOT EXISTS p2p_payment_proofs (
  seq            BIGSERIAL PRIMARY KEY,
  swap_id        TEXT NOT NULL,
  tx_id          TEXT NOT NULL,
  remark         TEXT,
  receipt_sha256 TEXT,
  -- receipt bytes live in the blob store when configured (`receipt_ref` is the
  -- blob key); this column stays for the no-blob fallback. Additive: boot ALTERs it in.
  receipt        TEXT,
  receipt_ref    TEXT,
  paid_at        BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_payment_proofs_swap_idx ON p2p_payment_proofs (swap_id, seq);

-- Device-side payment verdicts (docs/p2p.md §12): what a party's own device
-- agent read in their own rail app, signed by their DID key. Store-only
-- evidence — the counterparty name and capture refs never reach the chain, and
-- a full rebuild is expected to lose them (§14).
CREATE TABLE IF NOT EXISTS p2p_payment_verifications (
  seq               BIGSERIAL PRIMARY KEY,
  swap_id           TEXT NOT NULL,
  did               TEXT NOT NULL,
  side              TEXT NOT NULL,
  tx_id             TEXT,
  observed          TEXT NOT NULL,
  amount            TEXT,
  counterparty_name TEXT,
  remark            TEXT,
  paid_at           BIGINT,
  evidence_kind     TEXT NOT NULL,
  receipt_verified  BOOLEAN,
  captures          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_payment_verifications_swap_idx ON p2p_payment_verifications (swap_id, seq);

-- Device pairing grants (docs/p2p.md §12): the DID-signed consent that lets
-- the engine drive one mobile-mcp endpoint a user paired. Consent record —
-- store-only (the endpoint URL is a user's machine address; it never anchors).
CREATE TABLE IF NOT EXISTS p2p_pairings (
  did        TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  token      TEXT,
  swap_id    TEXT,
  issued_at  BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (did, pairing_id)
);
CREATE INDEX IF NOT EXISTS p2p_pairings_swap_idx ON p2p_pairings (swap_id);

-- Escrow spend signatures (docs/p2p.md §6, Path B): the seller's
-- pre-signatures over the deterministic release/refund skeletons, plus the
-- transaction hashes the engine submitted for them. Store-only — the
-- signatures are over transactions anyone can rebuild, and the row is what
-- lets the escrow hook finish a swap whose parties went offline.
CREATE TABLE IF NOT EXISTS p2p_escrow_signings (
  swap_id            TEXT PRIMARY KEY,
  refund_address     TEXT NOT NULL DEFAULT '',
  release_sig        TEXT NOT NULL DEFAULT '',
  refund_sig         TEXT NOT NULL DEFAULT '',
  -- Whose signature each blob is (the hook re-verifies against this did).
  release_signer_did TEXT NOT NULL DEFAULT '',
  refund_signer_did  TEXT NOT NULL DEFAULT '',
  seller_did         TEXT NOT NULL,
  release_txhash     TEXT,
  refund_txhash      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
