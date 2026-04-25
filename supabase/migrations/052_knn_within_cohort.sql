-- 052_knn_within_cohort.sql — k-NN sparsity helper for pattern consolidation
--
-- Background: scripts/consolidate-by-patterns.mjs used to emit a full
-- C(n,2) clique per tag-pair (every memory tagged BOTH tagA and tagB
-- linked to every other). For n=15 that's 105 edges per pattern, and
-- with dozens of strong patterns the relations graph turns into a
-- bipartite explosion: dominated by mechanical "tags-overlap" edges
-- with no signal about which memories actually inform each other.
--
-- Biological model: a neuron in a cohort doesn't connect to every other
-- neuron — it connects to its functional neighbors. We approximate that
-- here by k-NN over embeddings: for each memory in the cohort, link
-- only to its K most-similar peers (also in the cohort). After
-- canonical-ordering and dedup, each pattern produces O(n*k) edges
-- instead of O(n^2). With n=15, k=3 we go from 105 dense pairs to
-- ~20-25 sparse pairs — 4-5× sparser, and the surviving pairs are the
-- ones with actual semantic kinship.
--
-- This is read-only and pure: caller (the consolidate script) does the
-- chain_memories writes. Returning canonical (a_id < b_id, deduped)
-- saves the JS side from worrying about ordering.

CREATE OR REPLACE FUNCTION memory_knn_within_cohort(
  p_member_ids     UUID[],
  p_k              INT   DEFAULT 3,
  p_min_similarity FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  a_id       UUID,
  b_id       UUID,
  similarity FLOAT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH cohort AS (
    SELECT m.id, m.embedding
    FROM memories m
    WHERE m.id = ANY(p_member_ids)
      AND m.stage <> 'archived'
      AND m.embedding IS NOT NULL
  ),
  ranked AS (
    -- For each src, rank all other cohort members by cosine distance.
    -- ROW_NUMBER picks the top-K, ties broken by id for determinism.
    SELECT
      a.id AS src,
      b.id AS dst,
      (1.0 - (a.embedding <=> b.embedding))::FLOAT AS sim,
      ROW_NUMBER() OVER (
        PARTITION BY a.id
        ORDER BY a.embedding <=> b.embedding ASC, b.id ASC
      ) AS rnk
    FROM cohort a
    JOIN cohort b ON a.id <> b.id
  ),
  topk AS (
    SELECT src, dst, sim
    FROM ranked
    WHERE rnk <= p_k
      AND sim >= p_min_similarity
  ),
  canonical AS (
    SELECT
      LEAST(src, dst)    AS a_canon,
      GREATEST(src, dst) AS b_canon,
      MAX(sim)           AS sim_max
    FROM topk
    GROUP BY LEAST(src, dst), GREATEST(src, dst)
  )
  SELECT a_canon, b_canon, sim_max
  FROM canonical
  ORDER BY sim_max DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION memory_knn_within_cohort(UUID[], INT, FLOAT) TO anon, service_role;
