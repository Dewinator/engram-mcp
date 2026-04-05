-- Optimized HNSW index parameters for typical memory workloads (<100k entries)
-- m=16: connections per node (default 16, good balance speed/recall)
-- ef_construction=128: build-time search depth (higher = better recall, slower build)
DROP INDEX IF EXISTS memories_embedding_idx;
CREATE INDEX memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- Add index on source for duplicate detection during import
CREATE INDEX IF NOT EXISTS memories_source_idx
  ON memories (source) WHERE source IS NOT NULL;

-- Add index on tags for tag-based filtering
CREATE INDEX IF NOT EXISTS memories_tags_idx
  ON memories USING gin (tags);
