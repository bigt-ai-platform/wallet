-- asset-issuer schema (PostgreSQL).
--
-- Every operation carries a natural key for chain-observed work so a retry, a
-- reorg replay or a double webhook cannot mint twice:
--   unique (chain, tx_hash, log_index)
--
-- Balances and reserves are stored as NUMERIC(38,0) text-compatible integers
-- (smallest units). Never floats.

CREATE TABLE IF NOT EXISTS assets (
    asset_id          TEXT PRIMARY KEY,
    symbol            TEXT NOT NULL,
    external_decimals INTEGER NOT NULL CHECK (external_decimals BETWEEN 0 AND 36),
    l1_decimals       INTEGER NOT NULL DEFAULT 6 CHECK (l1_decimals = 6),
    max_supply_raw    NUMERIC(38, 0) NOT NULL,
    max_mint_raw      NUMERIC(38, 0) NOT NULL,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS reserves (
    asset_id     TEXT PRIMARY KEY REFERENCES assets (asset_id),
    reserve_raw  NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (reserve_raw >= 0),
    supply_raw   NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (supply_raw >= 0),
    dust_raw     NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (dust_raw >= 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- the solvency line, enforced by the database as well as the service
    CONSTRAINT reserve_covers_supply CHECK (supply_raw <= reserve_raw)
);

CREATE TABLE IF NOT EXISTS operations (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('deposit', 'mint', 'withdrawal', 'redeem', 'transfer')),
    asset_id      TEXT NOT NULL REFERENCES assets (asset_id),
    account       TEXT NOT NULL,
    amount_raw    NUMERIC(38, 0) NOT NULL CHECK (amount_raw > 0),
    l1_amount_raw NUMERIC(38, 0) NOT NULL CHECK (l1_amount_raw >= 0),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    chain         TEXT,
    tx_hash       TEXT,
    log_index     INTEGER,
    idempotency_key TEXT,
    external_ref  TEXT,
    -- verified EVM destination from a signed redemption intent
    destination   TEXT,
    -- external payout/mint tx hash, written before the ledger settles
    payout_ref    TEXT,
    -- token-creation reference for a mint (or 'attempted' while the signer runs)
    issuance_ref  TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT operation_ref_complete CHECK (
        (chain IS NULL AND tx_hash IS NULL AND log_index IS NULL)
        OR (chain IS NOT NULL AND tx_hash IS NOT NULL AND log_index IS NOT NULL)
    )
);

-- Existing databases: add the signed-intent destination column.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS destination TEXT;
-- Existing databases: add the payout/mint transaction hash.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS payout_ref TEXT;
-- Existing databases: add the reissuance reference for mints.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS issuance_ref TEXT;

-- idempotency: one operation per observed chain event
CREATE UNIQUE INDEX IF NOT EXISTS operations_chain_ref
    ON operations (chain, lower(tx_hash), log_index)
    WHERE chain IS NOT NULL;

-- Redemption refs are stored as the verifier's canonical outpoint (lower-case,
-- no `0x`). Normalize pre-rename rows so the unique index sees one identity;
-- a collision means two rows already authorize the same return and must be
-- reconciled by hand (warn instead of failing the whole schema apply).
DO $$
BEGIN
    UPDATE operations
       SET tx_hash = lower(regexp_replace(tx_hash, '^0x', ''))
     WHERE kind = 'redeem'
       AND tx_hash IS NOT NULL
       AND tx_hash <> lower(regexp_replace(tx_hash, '^0x', ''));
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'duplicate canonical redeem tx refs exist; reconcile operations before deploying';
END $$;

CREATE INDEX IF NOT EXISTS operations_account_created
    ON operations (account, created_at DESC);

-- idempotency for API-initiated requests (mobile retries), separate from chain refs
CREATE UNIQUE INDEX IF NOT EXISTS operations_client_key
    ON operations (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Signed redemption intents: the nonce/hash guard a replay, and the operation
-- carries the verified destination that the treasury may release to.
CREATE TABLE IF NOT EXISTS redeem_intents (
    asset_id     TEXT NOT NULL REFERENCES assets (asset_id),
    account      TEXT NOT NULL,
    nonce        TEXT NOT NULL,
    intent_hash  TEXT NOT NULL,
    destination  TEXT NOT NULL,
    amount_raw   NUMERIC(38, 0) NOT NULL CHECK (amount_raw > 0),
    expiry       BIGINT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, account, nonce),
    CONSTRAINT redeem_intent_hash_unique UNIQUE (intent_hash)
);

-- Mint capacity reservations: a worker reserves headroom (reserve + caps)
-- before calling the L1 signer, so two concurrent mints cannot both pass the
-- execution-time check. The settlement consumes the row.
CREATE TABLE IF NOT EXISTS mint_reservations (
    operation_id TEXT PRIMARY KEY,
    asset_id     TEXT NOT NULL REFERENCES assets (asset_id),
    amount_raw   NUMERIC(38, 0) NOT NULL CHECK (amount_raw > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mint_reservations_asset
    ON mint_reservations (asset_id);

CREATE TABLE IF NOT EXISTS holder_balances (
    asset_id      TEXT NOT NULL REFERENCES assets (asset_id),
    account       TEXT NOT NULL,
    available_raw NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (available_raw >= 0),
    pending_raw   NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (pending_raw >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, account)
);

-- Per-user EVM deposit addresses (Binance-style). One row per L1 account:
-- the address is the attribution key, because an ERC-20 transfer carries no
-- memo. `address` is stored lower-case; the API returns EIP-55.
-- Re-run this file on an existing database to add the table.
CREATE TABLE IF NOT EXISTS deposit_addresses (
    asset_id      TEXT NOT NULL REFERENCES assets (asset_id),
    account       TEXT NOT NULL,
    address       TEXT NOT NULL,
    address_index BIGINT NOT NULL CHECK (address_index >= 0),
    chain         TEXT NOT NULL DEFAULT 'ethereum',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, account),
    -- Global, not per asset: one address must never belong to two holders
    -- (the sweeper would reuse a nonce) or to two assets.
    CONSTRAINT deposit_address_address_unique UNIQUE (address),
    CONSTRAINT deposit_address_index_unique UNIQUE (address_index)
);

CREATE INDEX IF NOT EXISTS deposit_addresses_address
    ON deposit_addresses (lower(address));

-- Scanner cursor: the highest fully processed block per chain. The pass reads
-- it, scans forward to the finalized head, and only then advances it, so a
-- restart resumes instead of re-reading the same 2,000-block window forever.
CREATE TABLE IF NOT EXISTS scan_cursors (
    chain      TEXT PRIMARY KEY,
    block      BIGINT NOT NULL CHECK (block >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attestations (
    asset_id      TEXT NOT NULL REFERENCES assets (asset_id),
    version       BIGINT NOT NULL,
    reserve_raw   NUMERIC(38, 0) NOT NULL,
    supply_raw    NUMERIC(38, 0) NOT NULL,
    document_hash TEXT NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, version)
);

-- `completed` is terminal: no UPDATE may leave it.
CREATE OR REPLACE FUNCTION operations_no_completed_rewrite() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
        RAISE EXCEPTION 'operation % is completed and cannot be rewritten', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operations_completed_terminal ON operations;
CREATE TRIGGER operations_completed_terminal
    BEFORE UPDATE ON operations
    FOR EACH ROW EXECUTE FUNCTION operations_no_completed_rewrite();
