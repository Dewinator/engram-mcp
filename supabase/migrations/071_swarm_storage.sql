-- 071_swarm_storage.sql — Swarm Phase 3d (issue #88)
--
-- Storage floor for the GET /swarm/lessons and GET /swarm/hubs endpoints
-- (later Phase 3 / 4 issues), plus peer + local-trust columns on the
-- existing `nodes` table from migration 070.
--
-- Schemas mechanically derived from docs/SWARM_SPEC.md:
--   * swarm_lessons       ← §3.1 Lesson
--   * swarm_hub_anchors   ← §3.2 HubAnchor
--   * nodes (extended)    ← §3.3 NodeAdvertisement bookkeeping
--                            + §3.4 TrustEdge (LOCAL ONLY — see below)
--
-- Trust intentionally lives in two new `nodes` columns (`trust_weight`,
-- `trust_reason`) rather than a separate `trust_edges` table. SWARM_SPEC
-- §3.4 is explicit: "A node MAY expose its trust list to its operator
-- but MUST NOT expose it across the wire. There is intentionally no HTTP
-- endpoint that returns TrustEdge records." A one-row-per-peer view in
-- `nodes` satisfies the local-only contract and removes the temptation to
-- ever JOIN it into a /swarm/* response.
--
-- Verfassung pillar 6 (Cyber security): every record in swarm_lessons and
-- swarm_hub_anchors carries the producer's `signature` field. The wire-
-- validator (PR #89) verifies on ingest; the DB enforces the size/range
-- subset of the §5 rejection rules at the column level (defense in depth).
--
-- Index choice: HNSW on `vector_cosine_ops` to match every other embedding
-- index in this repo (memories, experiences, lessons, soul_traits,
-- intentions, people, stimuli — see migrations 002, 004, 015, 017, 022).
-- The issue body referred to ivfflat as a placeholder; HNSW is the
-- established pattern and keeps query plans uniform across vector tables.
--
-- This migration ONLY creates structure. No DROP, no DELETE, no data
-- backfill. The endpoints that READ these tables ship in later Phase 3/4
-- issues. Reed runs the migration manually after merge — the autonomy
-- loop is forbidden from executing it.

-- ---------------------------------------------------------------------------
-- (1) Extend `nodes` (from migration 070) with peer + local-trust columns.
-- All new columns are nullable or carry safe defaults so the bootstrap
-- is_self row from phase 1b survives without backfill. `pubkey_b64url`
-- mirrors the raw `pubkey` (BYTEA) column in the §3.3 wire encoding to
-- avoid encoding it on every read; `endpoint_url` is the §3.3 https-url
-- where the peer's /swarm/* endpoints live; `last_seen_at` records the
-- last successful contact (set by Phase 4 polling job, not this migration).
-- `trust_weight` and `trust_reason` are the §3.4 TrustEdge as flat
-- columns — never JOINed into a wire response.
-- ---------------------------------------------------------------------------
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS pubkey_b64url TEXT;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS endpoint_url  TEXT;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS trust_weight  REAL NOT NULL DEFAULT 0.5;
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS trust_reason  TEXT;

-- ---------------------------------------------------------------------------
-- (2) swarm_lessons — incoming + locally re-served Lesson records (§3.1).
-- All checks map to §5 rejection rules: rule 9 (signed_at >= created_at),
-- rule 11 (synthesized_from_cluster_size >= 2 floor), rule 12 (content
-- size cap, 8 KiB == 8192 octets).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swarm_lessons (
  id                            UUID PRIMARY KEY,
  content                       TEXT NOT NULL CHECK (octet_length(content) <= 8192),
  embedding                     VECTOR(768) NOT NULL,
  synthesized_from_cluster_size INT  NOT NULL CHECK (synthesized_from_cluster_size >= 2),
  origin_node_id                TEXT NOT NULL REFERENCES nodes(node_id),
  signed_at                     TIMESTAMPTZ NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL,
  signature                     TEXT NOT NULL,
  tags                          TEXT[],
  spec_version                  TEXT NOT NULL,
  received_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_verified_at         TIMESTAMPTZ,
  CHECK (signed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS swarm_lessons_signed_at_idx
  ON swarm_lessons (signed_at);
CREATE INDEX IF NOT EXISTS swarm_lessons_origin_signed_at_idx
  ON swarm_lessons (origin_node_id, signed_at);
CREATE INDEX IF NOT EXISTS swarm_lessons_embedding_hnsw
  ON swarm_lessons USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE swarm_lessons IS
  'Mycelium swarm: signed Lesson records received from peers and/or locally re-served. Schema mirrors docs/SWARM_SPEC.md §3.1. Column-level CHECKs enforce the size/range subset of the §5 rejection rules (defense in depth behind the wire-validator).';

-- ---------------------------------------------------------------------------
-- (3) swarm_hub_anchors — incoming + locally re-served HubAnchor records
-- (§3.2). The wire spec defines no `id` field for HubAnchor (it's a pointer,
-- not data); we use a local BIGSERIAL primary key for storage identity.
-- A unique (origin_node_id, embedding) constraint is intentionally NOT
-- added — comparing 768-dim vectors for equality is expensive and the
-- producer is allowed to re-publish a refined centroid for the same hub.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swarm_hub_anchors (
  id                    BIGSERIAL PRIMARY KEY,
  embedding             VECTOR(768) NOT NULL,
  hub_score             REAL NOT NULL CHECK (hub_score >= 0 AND hub_score <= 1),
  local_memory_count    INT  NOT NULL CHECK (local_memory_count >= 1),
  topic_label           TEXT CHECK (topic_label IS NULL OR octet_length(topic_label) <= 256),
  origin_node_id        TEXT NOT NULL REFERENCES nodes(node_id),
  signed_at             TIMESTAMPTZ NOT NULL,
  signature             TEXT NOT NULL,
  spec_version          TEXT NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS swarm_hub_anchors_embedding_hnsw
  ON swarm_hub_anchors USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE swarm_hub_anchors IS
  'Mycelium swarm: signed HubAnchor records (centroid + counts) received from peers. Schema mirrors docs/SWARM_SPEC.md §3.2. HubAnchors are pointers, not episode data — no content column.';
