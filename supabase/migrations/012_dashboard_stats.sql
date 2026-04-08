-- Dashboard aggregate: returns the full state of the memory store as one JSONB
-- payload, so the dashboard can render with a single round-trip.

CREATE OR REPLACE FUNCTION dashboard_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'memories',          count(*),
        'with_embedding',    count(embedding),
        'pinned',            count(*) FILTER (WHERE pinned),
        'episodic',          count(*) FILTER (WHERE stage = 'episodic'),
        'semantic',          count(*) FILTER (WHERE stage = 'semantic'),
        'archived',          count(*) FILTER (WHERE stage = 'archived'),
        'avg_strength',      COALESCE(avg(strength), 0),
        'avg_importance',    COALESCE(avg(importance), 0),
        'total_access',      COALESCE(sum(access_count), 0),
        'total_useful',      COALESCE(sum(useful_count), 0)
      )
      FROM memories
    ),
    'links', (
      SELECT jsonb_build_object(
        'count',     count(*),
        'avg_weight', COALESCE(avg(weight), 0),
        'max_weight', COALESCE(max(weight), 0)
      )
      FROM memory_links
    ),
    'forgotten', (
      SELECT count(*) FROM forgotten_memories
    ),
    'categories', (
      SELECT COALESCE(jsonb_agg(c ORDER BY (c->>'count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'name',         category,
          'count',        count(*),
          'avg_strength', avg(strength),
          'avg_importance', avg(importance)
        ) AS c
        FROM memories
        WHERE stage <> 'archived'
        GROUP BY category
      ) sub
    ),
    'tags', (
      SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'count')::int DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object('name', tag, 'count', count(*)) AS t
        FROM memories, unnest(tags) AS tag
        WHERE stage <> 'archived'
        GROUP BY tag
        ORDER BY count(*) DESC
        LIMIT 30
      ) sub
    ),
    'strength_histogram', (
      SELECT COALESCE(jsonb_agg(b ORDER BY (b->>'bucket')::int), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'bucket', LEAST(9, FLOOR(strength * 10))::int,
          'count', count(*)
        ) AS b
        FROM memories
        WHERE stage <> 'archived'
        GROUP BY LEAST(9, FLOOR(strength * 10))::int
      ) sub
    ),
    'recent', (
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',           id,
          'content',      LEFT(content, 200),
          'category',     category,
          'tags',         tags,
          'stage',        stage,
          'strength',     strength,
          'importance',   importance,
          'access_count', access_count,
          'useful_count', useful_count,
          'pinned',       pinned,
          'created_at',   created_at
        ) AS r
        FROM memories
        WHERE stage <> 'archived'
        ORDER BY created_at DESC
        LIMIT 25
      ) sub
    ),
    'strongest', (
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'id',           id,
          'content',      LEFT(content, 160),
          'category',     category,
          'strength',     strength,
          'access_count', access_count,
          'useful_count', useful_count
        ) AS r
        FROM memories
        WHERE stage <> 'archived'
        ORDER BY strength * (1 + ln(1 + access_count + useful_count * 2)) DESC
        LIMIT 10
      ) sub
    ),
    'generated_at', NOW()
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION dashboard_stats() TO anon, service_role;
