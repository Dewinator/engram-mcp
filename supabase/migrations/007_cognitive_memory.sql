-- Cognitive memory model: strength, decay, rehearsal, salience, associations.
-- Goal: model human-like memory (Ebbinghaus decay, testing effect, Hebbian links,
-- consolidation episodic→semantic, soft forgetting).

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS strength         FLOAT       NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS importance       FLOAT       NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS access_count     INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valence          FLOAT       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arousal          FLOAT       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage            TEXT        NOT NULL DEFAULT 'episodic',
  ADD COLUMN IF NOT EXISTS pinned           BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS decay_tau_days   FLOAT       NOT NULL DEFAULT 30;

ALTER TABLE memories
  DROP CONSTRAINT IF EXISTS memories_stage_check;
ALTER TABLE memories
  ADD CONSTRAINT memories_stage_check
  CHECK (stage IN ('episodic', 'semantic', 'archived'));

CREATE INDEX IF NOT EXISTS memories_stage_idx           ON memories (stage);
CREATE INDEX IF NOT EXISTS memories_last_accessed_idx   ON memories (last_accessed_at);
CREATE INDEX IF NOT EXISTS memories_strength_idx        ON memories (strength);

-- Hebbian association graph: memories that co-activate get linked, link weight grows.
CREATE TABLE IF NOT EXISTS memory_links (
  a UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  b UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  weight FLOAT NOT NULL DEFAULT 0.1,
  last_coactivated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (a, b),
  CHECK (a < b)  -- canonical ordering, undirected
);
CREATE INDEX IF NOT EXISTS memory_links_a_idx ON memory_links (a);
CREATE INDEX IF NOT EXISTS memory_links_b_idx ON memory_links (b);

-- Soft-forgotten archive: biologically, "forgetting" is loss of access, not erasure.
CREATE TABLE IF NOT EXISTS forgotten_memories (
  LIKE memories INCLUDING ALL
);
ALTER TABLE forgotten_memories
  ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS forgotten_reason TEXT;
