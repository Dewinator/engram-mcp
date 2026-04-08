-- Cognitive recall: relevance × strength × salience.
--
-- effective_score = relevance * strength_now * salience
--   relevance      = vector_weight*cosine + (1-vector_weight)*bm25
--   strength_now   = strength * exp(-age_days / (tau * (1 + importance)))
--                              * (1 + ln(1 + access_count))
--   salience       = 1 + 0.3*|valence| + 0.3*arousal + (pinned ? 1 : 0)
--   age_days       = days since COALESCE(last_accessed_at, created_at)

CREATE OR REPLACE FUNCTION match_memories_cognitive(
  query_embedding VECTOR(768),
  query_text      TEXT  DEFAULT '',
  match_count     INT   DEFAULT 10,
  filter_category TEXT  DEFAULT NULL,
  vector_weight   FLOAT DEFAULT 0.6,
  include_archived BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id               UUID,
  content          TEXT,
  category         TEXT,
  tags             TEXT[],
  metadata         JSONB,
  source           TEXT,
  stage            TEXT,
  strength         FLOAT,
  importance       FLOAT,
  access_count     INT,
  pinned           BOOLEAN,
  relevance        FLOAT,
  strength_now     FLOAT,
  salience         FLOAT,
  effective_score  FLOAT,
  created_at       TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      m.id,
      1 - (m.embedding <=> query_embedding) AS vector_score
    FROM memories m
    WHERE m.embedding IS NOT NULL
      AND (include_archived OR m.stage <> 'archived')
      AND (filter_category IS NULL OR m.category = filter_category)
    ORDER BY m.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 5, 50)
  ),
  fts_results AS (
    SELECT
      m.id,
      ts_rank(to_tsvector('german', m.content), plainto_tsquery('german', query_text)) AS fts_score
    FROM memories m
    WHERE query_text <> ''
      AND to_tsvector('german', m.content) @@ plainto_tsquery('german', query_text)
      AND (include_archived OR m.stage <> 'archived')
      AND (filter_category IS NULL OR m.category = filter_category)
  ),
  scored AS (
    SELECT
      m.id,
      m.content,
      m.category,
      m.tags,
      m.metadata,
      m.source,
      m.stage,
      m.strength,
      m.importance,
      m.access_count,
      m.pinned,
      m.created_at,
      m.last_accessed_at,
      (vector_weight * vr.vector_score
        + (1 - vector_weight) * COALESCE(fr.fts_score, 0))::FLOAT AS relevance,
      (m.strength
        * exp(
            - GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(m.last_accessed_at, m.created_at))) / 86400.0, 0)
            / NULLIF(m.decay_tau_days * (1 + m.importance), 0)
          )
        * (1 + ln(1 + m.access_count))
      )::FLOAT AS strength_now,
      (1 + 0.3 * abs(m.valence) + 0.3 * m.arousal + CASE WHEN m.pinned THEN 1 ELSE 0 END)::FLOAT AS salience
    FROM vector_results vr
    JOIN memories m ON m.id = vr.id
    LEFT JOIN fts_results fr ON fr.id = vr.id
  )
  SELECT
    s.id, s.content, s.category, s.tags, s.metadata, s.source, s.stage,
    s.strength, s.importance, s.access_count, s.pinned,
    s.relevance, s.strength_now, s.salience,
    (s.relevance * s.strength_now * s.salience)::FLOAT AS effective_score,
    s.created_at, s.last_accessed_at
  FROM scored s
  ORDER BY effective_score DESC
  LIMIT match_count;
END;
$$;

-- Rehearsal / testing effect: strengthen a memory when it is successfully recalled.
-- Strength bump is bounded; access_count grows logarithmically in score anyway.
CREATE OR REPLACE FUNCTION touch_memories(memory_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE memories
  SET
    access_count = access_count + 1,
    last_accessed_at = NOW(),
    strength = LEAST(strength * 1.10 + 0.05, 10.0)
  WHERE id = ANY(memory_ids);
END;
$$;

-- Hebbian co-activation: strengthen / create links between memories that fired together.
CREATE OR REPLACE FUNCTION coactivate_memories(memory_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  i INT;
  j INT;
  a UUID;
  b UUID;
BEGIN
  IF array_length(memory_ids, 1) IS NULL OR array_length(memory_ids, 1) < 2 THEN
    RETURN;
  END IF;
  FOR i IN 1 .. array_length(memory_ids, 1) - 1 LOOP
    FOR j IN i + 1 .. array_length(memory_ids, 1) LOOP
      IF memory_ids[i] < memory_ids[j] THEN
        a := memory_ids[i]; b := memory_ids[j];
      ELSE
        a := memory_ids[j]; b := memory_ids[i];
      END IF;
      INSERT INTO memory_links (a, b, weight, last_coactivated_at)
      VALUES (a, b, 0.1, NOW())
      ON CONFLICT (a, b) DO UPDATE
        SET weight = LEAST(memory_links.weight + 0.1, 5.0),
            last_coactivated_at = NOW();
    END LOOP;
  END LOOP;
END;
$$;

-- Spreading activation: given seed memory ids, return their neighbors with link-weighted score.
CREATE OR REPLACE FUNCTION spread_activation(
  seed_ids UUID[],
  max_neighbors INT DEFAULT 5
)
RETURNS TABLE (
  id            UUID,
  content       TEXT,
  category      TEXT,
  tags          TEXT[],
  link_strength FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH neighbors AS (
    SELECT ml.b AS nid, ml.weight FROM memory_links ml WHERE ml.a = ANY(seed_ids)
    UNION ALL
    SELECT ml.a AS nid, ml.weight FROM memory_links ml WHERE ml.b = ANY(seed_ids)
  ),
  agg AS (
    SELECT nid, SUM(weight) AS total
    FROM neighbors
    WHERE NOT (nid = ANY(seed_ids))
    GROUP BY nid
    ORDER BY total DESC
    LIMIT max_neighbors
  )
  SELECT m.id, m.content, m.category, m.tags, agg.total::FLOAT
  FROM agg
  JOIN memories m ON m.id = agg.nid
  WHERE m.stage <> 'archived';
END;
$$;

-- Consolidation: episodic memories with enough rehearsals become semantic.
-- Semantic memories decay slower (longer tau).
CREATE OR REPLACE FUNCTION consolidate_memories(
  min_access_count INT DEFAULT 3,
  min_age_days     INT DEFAULT 1
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  promoted INT;
BEGIN
  WITH updated AS (
    UPDATE memories
    SET stage = 'semantic',
        decay_tau_days = decay_tau_days * 4,
        strength = strength * 1.2
    WHERE stage = 'episodic'
      AND access_count >= min_access_count
      AND created_at < NOW() - (min_age_days || ' days')::INTERVAL
    RETURNING id
  )
  SELECT count(*) INTO promoted FROM updated;
  RETURN promoted;
END;
$$;

-- Soft forgetting: archive (don't delete) memories whose effective strength has decayed
-- below a threshold and that aren't pinned. Biologically: trace becomes inaccessible.
CREATE OR REPLACE FUNCTION forget_weak_memories(
  strength_threshold FLOAT DEFAULT 0.05,
  min_age_days       INT   DEFAULT 7
)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  archived INT;
BEGIN
  WITH candidates AS (
    SELECT m.id
    FROM memories m
    WHERE m.pinned = FALSE
      AND m.stage <> 'archived'
      AND m.created_at < NOW() - (min_age_days || ' days')::INTERVAL
      AND (
        m.strength
        * exp(
            - GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(m.last_accessed_at, m.created_at))) / 86400.0, 0)
            / NULLIF(m.decay_tau_days * (1 + m.importance), 0)
          )
      ) < strength_threshold
  ),
  moved AS (
    INSERT INTO forgotten_memories
    SELECT m.*, NOW(), 'decay below threshold'
    FROM memories m WHERE m.id IN (SELECT id FROM candidates)
    RETURNING id
  )
  UPDATE memories SET stage = 'archived' WHERE id IN (SELECT id FROM moved)
  RETURNING 1 INTO archived;

  GET DIAGNOSTICS archived = ROW_COUNT;
  RETURN archived;
END;
$$;
