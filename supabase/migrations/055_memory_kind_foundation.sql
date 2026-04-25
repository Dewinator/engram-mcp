-- 055_memory_kind_foundation.sql — Phase 4a foundation for atomization
--
-- Ziel-Architektur (memory 75105113): "alle Memories atomar, Hubs entstehen
-- emergent aus Graph-Zentralität (degree × weighted betweenness in
-- memory_links). Lessons/Traits werden Views über Hub-Subgraphen statt
-- eigener Tabellen."
--
-- Phase 4 collapses the four ad-hoc cognitive tables (lessons, soul_traits,
-- experiences, intentions) into the canonical `memories` table with a
-- `kind` discriminator. The old tables become VIEWS for backward compat
-- until Phase 5 makes them emergent (lessons/traits as queries over
-- high-centrality memories) or removes them entirely.
--
-- This migration ONLY adds the foundation: a `kind` column with a
-- whitelist CHECK and an index. No data migration, no view trickery.
-- Existing rows are stamped 'memory' (the default). Future migrations
-- (056_atomize_lessons, 057_atomize_traits, …) do the per-table
-- collapse one at a time, each behind its own rollback boundary —
-- the lessons table alone touches 17 SQL functions plus an FK from
-- experiences, so any single-shot atomization is a real surgery.
--
-- Why a separate `kind` column rather than overloading `category`:
--   * `category` carries SUB-classification of memories ('people',
--     'projects', 'topics', 'decisions', 'tool', …) and a lesson can
--     legitimately have its own category (e.g. a lesson about a
--     person). Conflating the two loses information.
--   * `kind` is the TYPE of cognitive object (memory/lesson/trait/
--     experience/intention) — orthogonal to category.
--   * recall and spreading-activation can filter on kind without
--     having to reason about which categories are "really memories"
--     vs. "really lessons" — the discriminator is explicit.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'memory';

-- Whitelist enforced via CHECK so no agent can sneak an unrecognised
-- kind in. Extending this list is a deliberate migration step.
ALTER TABLE memories
  ADD CONSTRAINT memories_kind_whitelist
  CHECK (kind IN ('memory', 'lesson', 'trait', 'experience', 'intention', 'tool', 'note'))
  NOT VALID;

ALTER TABLE memories VALIDATE CONSTRAINT memories_kind_whitelist;

CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories (kind);

-- Composite index for the common "kind + category" query pattern that
-- recall will use once cross-kind retrieval ships.
CREATE INDEX IF NOT EXISTS memories_kind_category_idx ON memories (kind, category);

-- Convenience view: lessons that already exist as memories (kind='lesson').
-- Empty until 056 backfills, but defining it here so callers can write
-- queries against `memories_lessons_view` ahead of the cutover and not
-- need to coordinate with the atomization migration.
CREATE OR REPLACE VIEW memories_by_kind AS
  SELECT kind, count(*) AS n, count(DISTINCT category) AS distinct_categories
  FROM memories
  GROUP BY kind
  ORDER BY n DESC;

GRANT SELECT ON memories_by_kind TO anon, service_role;
