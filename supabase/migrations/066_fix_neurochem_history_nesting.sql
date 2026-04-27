-- Migration 066 — fix neurochem history JSONB nesting bug (issue #57).
--
-- ROOT CAUSE
-- ----------
-- mig 042's neurochem_apply() appends to agent_neurochemistry.history via
--
--   v_new_history := (
--     SELECT jsonb_agg(x) FROM (
--       SELECT * FROM jsonb_array_elements(s.history)
--       UNION ALL
--       SELECT jsonb_build_object(...) ) x
--   );
--
-- jsonb_array_elements() returns a function output column literally named
-- `value`. SELECT * therefore yields rows with a single column called
-- `value`. UNION ALL re-uses the first SELECT's column name; the new
-- snapshot from jsonb_build_object becomes another `value` row. jsonb_agg
-- over a record-typed `x` wraps each row in an object — `{"value": <elem>}`.
-- Next iteration the wrapped element is now stored, so the unwrap that
-- doesn't happen wraps it AGAIN. Observed: 30 nested wrappers on `main`.
--
-- mig 042's neurochem_history() has a parallel issue: the LIMIT sits on the
-- outer scalar SELECT (1 row from jsonb_agg) instead of the inner row set,
-- so it returned the full history regardless of p_limit.
--
-- FIX
-- ---
-- 1. neurochem_apply: replace the SELECT * + UNION + jsonb_agg pattern with
--    plain jsonb concatenation `s.history || jsonb_build_array(...)`.
--    Idiomatic PG, no record-row trap.
-- 2. neurochem_history: move LIMIT inside the ordered subquery so it
--    actually limits the output array.
-- 3. Cleanup: walk every existing agent_neurochemistry.history row, unwrap
--    any `{"value": ...}` chain element-wise, write back. Idempotent on
--    already-clean rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. _nc_unwrap_value(p) — recursively peel `{"value": <inner>}` wrappers.
-- Stops at the first object that is not exactly `{value: …}` (i.e. has
-- multiple keys or no `value` key) — that's the original snapshot shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _nc_unwrap_value(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_keys TEXT[];
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  WHILE jsonb_typeof(p) = 'object' LOOP
    SELECT array_agg(k) INTO v_keys FROM jsonb_object_keys(p) k;
    EXIT WHEN array_length(v_keys, 1) IS DISTINCT FROM 1 OR v_keys[1] <> 'value';
    p := p -> 'value';
  END LOOP;
  RETURN p;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Patch neurochem_apply — body unchanged except for the history-build.
-- Keeping every other line byte-identical to mig 042 minimises review surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_apply(
  p_label       TEXT,
  p_event       TEXT,
  p_outcome     DOUBLE PRECISION DEFAULT NULL,
  p_intensity   DOUBLE PRECISION DEFAULT 1.0
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  s agent_neurochemistry%ROWTYPE;
  v_delta DOUBLE PRECISION := 0;
  v_new_dopamine    DOUBLE PRECISION;
  v_new_prediction  DOUBLE PRECISION;
  v_new_serotonin   DOUBLE PRECISION;
  v_na_delta        DOUBLE PRECISION := 0;
  v_new_na          DOUBLE PRECISION;
  v_new_snapshot    JSONB;
  v_new_history     JSONB;
  v_consecutive     INT;
BEGIN
  v_id := neurochem_get_or_init(p_label);
  SELECT * INTO s FROM agent_neurochemistry WHERE id = v_id;

  ----- Dopamin (nur bei Events mit Outcome)
  IF p_outcome IS NOT NULL THEN
    v_delta := p_outcome - s.dopamine_prediction;
    v_new_dopamine   := _nc_clamp(s.dopamine_baseline + v_delta * 2.0);
    v_new_prediction := _nc_clamp(s.dopamine_prediction + s.dopamine_lr * v_delta);
  ELSE
    v_new_dopamine   := s.dopamine_current;
    v_new_prediction := s.dopamine_prediction;
  END IF;

  ----- Serotonin (langsamer Trend Richtung outcome)
  IF p_outcome IS NOT NULL THEN
    v_new_serotonin := _nc_clamp(s.serotonin_current + 0.05 * (p_outcome - s.serotonin_current));
  ELSIF p_event = 'idle' THEN
    v_new_serotonin := _nc_clamp(s.serotonin_current - s.serotonin_decay_rate);
  ELSE
    v_new_serotonin := s.serotonin_current;
  END IF;

  ----- Noradrenalin (Event-getrieben, plus Decay Richtung optimal)
  v_na_delta := CASE p_event
    WHEN 'novel_stimulus'    THEN  0.20 * p_intensity
    WHEN 'error'             THEN  0.25 * p_intensity
    WHEN 'task_failed'       THEN  0.18 * p_intensity
    WHEN 'task_complete'     THEN -0.05 * p_intensity
    WHEN 'familiar_task'     THEN -0.05 * p_intensity
    WHEN 'teacher_consulted' THEN -0.08 * p_intensity
    WHEN 'idle'              THEN -0.10 * p_intensity
    ELSE 0
  END;
  v_new_na := _nc_clamp(s.noradrenaline_current + v_na_delta + (s.noradrenaline_optimal - s.noradrenaline_current) * 0.10);

  ----- Consecutive-Failures Counter
  v_consecutive := CASE
    WHEN p_event IN ('task_failed', 'error') THEN s.consecutive_failures + 1
    WHEN p_event IN ('task_complete', 'familiar_task') THEN 0
    ELSE s.consecutive_failures
  END;

  ----- mig 066 — history append via plain JSONB concatenation. The old
  -- SELECT * + UNION + jsonb_agg path wrapped each iteration's elements in
  -- `{"value": …}` (issue #57). `||` on JSONB arrays is straight append.
  v_new_snapshot := jsonb_build_object(
    't',   to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'e',   p_event,
    'o',   p_outcome,
    'd',   ROUND(v_delta::numeric, 4),
    'da',  ROUND(v_new_dopamine::numeric, 4),
    'dp',  ROUND(v_new_prediction::numeric, 4),
    'se',  ROUND(v_new_serotonin::numeric, 4),
    'na',  ROUND(v_new_na::numeric, 4),
    'cf',  v_consecutive
  );
  v_new_history := COALESCE(s.history, '[]'::jsonb) || jsonb_build_array(v_new_snapshot);

  IF jsonb_array_length(v_new_history) > 30 THEN
    v_new_history := (
      SELECT jsonb_agg(value ORDER BY ordinality ASC)
      FROM (
        SELECT value, ordinality
        FROM jsonb_array_elements(v_new_history) WITH ORDINALITY
        ORDER BY ordinality DESC LIMIT 30
      ) t
    );
  END IF;

  UPDATE agent_neurochemistry SET
    dopamine_current      = v_new_dopamine,
    dopamine_prediction   = v_new_prediction,
    serotonin_current     = v_new_serotonin,
    noradrenaline_current = v_new_na,
    consecutive_failures  = v_consecutive,
    last_event            = p_event,
    last_outcome          = p_outcome,
    history               = v_new_history,
    updated_at            = NOW()
  WHERE id = v_id;

  RETURN neurochem_get_compat(p_label);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Patch neurochem_history — move LIMIT inside the ordered subquery so it
-- actually limits the rows fed into jsonb_agg.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neurochem_history(p_label TEXT, p_limit INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE s agent_neurochemistry%ROWTYPE;
BEGIN
  SELECT n.* INTO s FROM agent_neurochemistry n
    JOIN agent_genomes g ON g.id = n.agent_genome_id
    WHERE g.label = p_label;
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN COALESCE(
    (SELECT jsonb_agg(value ORDER BY ordinality DESC)
     FROM (
       SELECT value, ordinality
       FROM jsonb_array_elements(s.history) WITH ORDINALITY
       ORDER BY ordinality DESC
       LIMIT GREATEST(1, p_limit)
     ) t
    ),
    '[]'::jsonb
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. One-time cleanup of existing corrupt history arrays. Idempotent on
-- already-clean rows because _nc_unwrap_value short-circuits the moment it
-- sees a multi-key object.
-- ---------------------------------------------------------------------------
UPDATE agent_neurochemistry SET history = (
  SELECT COALESCE(jsonb_agg(_nc_unwrap_value(value) ORDER BY ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(history) WITH ORDINALITY
)
WHERE history IS NOT NULL AND jsonb_array_length(history) > 0;

-- ---------------------------------------------------------------------------
-- 5. Sanity — main's first element must now be a flat snapshot object (i.e.
-- have all the documented keys). Refuses to commit otherwise.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v JSONB;
BEGIN
  SELECT n.history -> 0 INTO v
  FROM agent_neurochemistry n
  JOIN agent_genomes g ON g.id = n.agent_genome_id
  WHERE g.label = 'main';
  IF v IS NULL THEN
    -- 'main' may have an empty history if neurochem was never applied; that's fine.
    RETURN;
  END IF;
  IF NOT (v ? 't' AND v ? 'e' AND v ? 'da' AND v ? 'na' AND v ? 'se') THEN
    RAISE EXCEPTION '066 sanity: main.history[0] still nested or malformed: %', v;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION _nc_unwrap_value(JSONB) TO anon, service_role;

COMMIT;
