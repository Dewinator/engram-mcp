-- 051_fix_coactivate_memories.sql — Fix variable-shadowing bug and unify
-- the synchronous Hebbian path with the event-bus path.
--
-- Background: the original coactivate_memories (Migration 008) declared
-- two PL/pgSQL variables named `a` and `b`. memory_links also has columns
-- named `a` and `b`. In ON CONFLICT (a, b), the planner cannot tell which
-- `a` is meant — PL/pgSQL raises "column reference 'a' is ambiguous" and
-- the call dies. The error was logged via console.error from the MCP
-- server but never surfaced, so the synchronous Hebbian hot-path has
-- been broken at the SQL level since the function was created.
--
-- Two fixes in one migration:
--   1. Replace the function body to use coactivate_pair() for each pair.
--      That gives us ONE canonical Hebbian formula (smooth additive bump
--      with cap at 1.0, plus coactivation_count and the `coactivated`
--      memory_event for telemetry) instead of two inconsistent formulas.
--   2. Tighten the GRANT (already added in 050 but re-issued here so the
--      function and grant move together if 050 is replayed/edited).

CREATE OR REPLACE FUNCTION coactivate_memories(memory_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  i INT;
  j INT;
  n INT;
  v_delta FLOAT;
BEGIN
  n := array_length(memory_ids, 1);
  IF n IS NULL OR n < 2 THEN
    RETURN;
  END IF;

  -- Match the agent's graduated delta: smaller bump for larger sets so
  -- a single dense recall doesn't dominate the graph.
  IF n <= 2 THEN
    v_delta := 0.08;
  ELSIF n <= 5 THEN
    v_delta := 0.05;
  ELSE
    v_delta := 0.03;
  END IF;

  FOR i IN 1 .. n - 1 LOOP
    FOR j IN i + 1 .. n LOOP
      PERFORM coactivate_pair(memory_ids[i], memory_ids[j], v_delta);
    END LOOP;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION coactivate_memories(UUID[]) TO anon, service_role;
