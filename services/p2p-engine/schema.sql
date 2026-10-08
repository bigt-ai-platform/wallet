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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_orders_open_idx ON p2p_orders (status, created_at DESC);

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

-- CNY rails (docs/p2pcny.md): the seller's collection profile (PII — never
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
  receipt        TEXT,
  paid_at        BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS p2p_payment_proofs_swap_idx ON p2p_payment_proofs (swap_id, seq);
