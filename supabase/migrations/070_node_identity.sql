-- 070_node_identity.sql — Swarm Phase 1a (issue #75)
--
-- Cryptographic identity of THIS mycelium node, and (later) any peers we
-- have ever spoken to. Wire format defined by docs/SWARM_SPEC.md
-- (NodeAdvertisement, landed in PR #78 / phase 0).
--
-- Verfassung pillar 1 (Souveränität): the PRIVATE key never lives in this
-- table. It stays OUTSIDE the database in a chmod-600 file at
-- ~/.mycelium/node.key. Only the public key and the derived node_id
-- (multihash of the pubkey) are stored here. A DB compromise alone must
-- not yield the secret.
--
-- This migration ONLY creates structure. No DROP, no DELETE, no data
-- backfill. The bootstrap row that flips is_self=true is written by a
-- separate keypair-generation script in phase 1b (different issue) — that
-- script is the only place the private key is touched, immediately after
-- which it is written to the chmod-600 file and discarded from memory.

CREATE TABLE IF NOT EXISTS nodes (
  node_id      TEXT PRIMARY KEY,                  -- multihash(pubkey), e.g. "mc1q..."
  pubkey       BYTEA NOT NULL,                    -- raw Ed25519 public key (32 bytes)
  display_name TEXT,                              -- free-form, not unique
  is_self      BOOLEAN NOT NULL DEFAULT FALSE,    -- exactly one row may have true
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index — at most one row may carry is_self=true. PostgreSQL
-- has no native "exactly-one-true" constraint; a partial unique index on a
-- constant expression with `WHERE is_self` enforces the "at most one" half.
-- The "exactly one" half (i.e. presence of a self row at all) is the
-- responsibility of the phase 1b bootstrap script, not of SQL.
--
-- The DEFAULT FALSE on is_self is what makes this safe against accidental
-- INSERTs of peers without spelling out is_self — they fall outside the
-- partial index and cannot collide with the self row.
CREATE UNIQUE INDEX IF NOT EXISTS nodes_only_one_self
  ON nodes ((1)) WHERE is_self;

COMMENT ON TABLE nodes IS
  'Mycelium swarm: cryptographic identity of this node and any peers we have ever spoken to. Private keys live OUTSIDE this row (chmod-600 file at ~/.mycelium/node.key). Wire format: docs/SWARM_SPEC.md NodeAdvertisement.';
