-- 062_compute_affect.sql
--
-- Phase 2 of the brain-core roadmap (Reed 2026-04-26).
-- Implements compute_affect() per docs/affect-observables.md — the affect
-- engine moves from LLM-pushed to observable-derived. The four legacy
-- dimensions (curiosity, frustration, satisfaction, confidence) plus the
-- new valence/arousal pair are computed from data we already collect:
-- experiences, memory_events, skill_outcomes, stimuli.
--
-- Side-effects of this migration, in order:
--   1. Drift fixes (memory_events.event_type CHECK + recall_touch mapping).
--   2. agent_affect history table + valence/arousal columns.
--   3. compute_affect() — pure SQL, no side-effects, can be tested live.
--   4. apply_compute_affect(trigger) — wrapper that patches agent_affect.
--   5. Triggers on experiences INSERT and memory_events INSERT (whitelist).
--   6. Sanity DO-block — refuses to commit a broken function.
--
-- The MCP server still calls affect_apply() from remember/recall/absorb —
-- that's intentional. apply_compute_affect() is the new authoritative
-- writer; affect_apply() is demoted to a logging shim. Step 8 of the
-- roadmap (drop affect_apply emissions from the tools) is a separate PR.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1a. memory_events.event_type CHECK was missing 'contradiction_resolved'
-- even though RelationsService.maybeEmitContradictionResolve emits it. Every
-- emission would silently violate the CHECK and abort the transaction.
-- We also add 'compute_affect' for emissions when this migration's wrapper
-- patches agent_affect.
-- ---------------------------------------------------------------------------
ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_event_type_check;
ALTER TABLE memory_events ADD CONSTRAINT memory_events_event_type_check
  CHECK (event_type IN (
    'created', 'updated', 'archived', 'restored', 'superseded',
    'accessed', 'recalled', 'used_in_response', 'pinned', 'unpinned',
    'promoted', 'demoted', 'positive_feedback', 'negative_feedback',
    'mark_useful', 'emphasis_bump',
    'relation_added', 'relation_removed', 'coactivated',
    'guard_hit', 'guard_miss', 'prevention_hit', 'prevention_miss',
    'conscience_warning', 'contradiction_detected', 'contradiction_resolved',
    'agent_triggered', 'agent_completed', 'agent_error',
    'consolidation_done', 'synthesis_created',
    'reasoning_trace', 'tool_call_trace', 'prompt_received',
    'note',
    'compute_affect'
  ));

-- ---------------------------------------------------------------------------
-- 1b. recall_touch was unmapped in affect_apply()'s CASE statement (Phase 1
-- drift). It used to fall through to the ELSE branch and reach
-- neurochem_apply with its raw label, which is not a recognised event. Map
-- it to familiar_task with mid-outcome (0.5) — a 'touch' is a single weak
-- hit: not empty, not a hit storm, just a brush.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION affect_apply(p_event TEXT, p_intensity DOUBLE PRECISION DEFAULT 0.1)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_outcome   DOUBLE PRECISION;
  v_new_event TEXT;
BEGIN
  CASE p_event
    WHEN 'success'        THEN v_outcome := 0.8;  v_new_event := 'task_complete';
    WHEN 'failure'        THEN v_outcome := 0.2;  v_new_event := 'task_failed';
    WHEN 'unknown'        THEN v_outcome := NULL; v_new_event := 'novel_stimulus';
    WHEN 'recall_empty'   THEN v_outcome := 0.3;  v_new_event := 'novel_stimulus';
    WHEN 'recall_rich'    THEN v_outcome := 0.7;  v_new_event := 'familiar_task';
    WHEN 'recall_touch'   THEN v_outcome := 0.5;  v_new_event := 'familiar_task';
    WHEN 'novel_encoding' THEN v_outcome := NULL; v_new_event := 'novel_stimulus';
    ELSE v_outcome := NULL; v_new_event := p_event;
  END CASE;
  PERFORM neurochem_apply('main', v_new_event, v_outcome, GREATEST(0.5, LEAST(2.0, p_intensity * 10)));
  RETURN neurochem_get_compat('main');
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. agent_affect: add valence + arousal columns, history table, snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_affect
  ADD COLUMN IF NOT EXISTS valence DOUBLE PRECISION CHECK (valence BETWEEN -1 AND 1);
ALTER TABLE agent_affect
  ADD COLUMN IF NOT EXISTS arousal DOUBLE PRECISION CHECK (arousal BETWEEN  0 AND 1);

CREATE TABLE IF NOT EXISTS agent_affect_history (
  id            BIGSERIAL PRIMARY KEY,
  curiosity     DOUBLE PRECISION NOT NULL,
  frustration   DOUBLE PRECISION NOT NULL,
  satisfaction  DOUBLE PRECISION NOT NULL,
  confidence    DOUBLE PRECISION NOT NULL,
  valence       DOUBLE PRECISION,
  arousal       DOUBLE PRECISION,
  source        TEXT NOT NULL,                -- 'compute_affect' | 'snapshot'
  trigger_event TEXT,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_affect_history_at_idx
  ON agent_affect_history (computed_at DESC);

-- One-time freeze of the LLM-pushed-era agent_affect into history. Idempotent
-- via the source/trigger marker — running migration twice yields one snapshot.
INSERT INTO agent_affect_history (
  curiosity, frustration, satisfaction, confidence, valence, arousal,
  source, trigger_event, computed_at
)
SELECT a.curiosity, a.frustration, a.satisfaction, a.confidence, a.valence, a.arousal,
       'snapshot', 'phase-2-pivot', a.updated_at
FROM agent_affect a
WHERE NOT EXISTS (
  SELECT 1 FROM agent_affect_history h
  WHERE h.source = 'snapshot' AND h.trigger_event = 'phase-2-pivot'
);

-- ---------------------------------------------------------------------------
-- 3. compute_affect() — pure SQL, no side-effects.
-- Returns the six dimensions as JSONB. The formulas mirror
-- docs/affect-observables.md — every weight and time-window is exposed as a
-- DECLARE'd constant at the top of the function so that the post-observation
-- tuning pass (~2 weeks of live data) can edit one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_affect()
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  -- ---- tunable constants (see docs/affect-observables.md §Tuning notes) ----
  v_valence_window_h INT := 72;
  v_satisfaction_h   INT := 24;
  v_curiosity_h      INT := 24;
  v_frustration_h    INT := 24;
  v_confidence_h     INT := 48;
  v_event_rate_min   INT := 15;
  v_useful_short_h   INT := 6;
  v_useful_long_h    INT := 12;
  v_open_conf_h      INT := 48;
  v_curiosity_base   DOUBLE PRECISION := 0.3;

  -- ---- scratch ----
  v_valence       DOUBLE PRECISION;
  v_arousal       DOUBLE PRECISION;
  v_curiosity     DOUBLE PRECISION;
  v_satisfaction  DOUBLE PRECISION;
  v_frustration   DOUBLE PRECISION;
  v_confidence    DOUBLE PRECISION;
  v_prev_conf     DOUBLE PRECISION;

  v_event_rate    DOUBLE PRECISION;
  v_tool_div      DOUBLE PRECISION;
  v_novel_stim    DOUBLE PRECISION;

  v_empty         INT;
  v_lowconf       INT;
  v_cluster_gaps  DOUBLE PRECISION;

  v_succ_rate     DOUBLE PRECISION;
  v_pleased       DOUBLE PRECISION;
  v_useful_delta  INT;

  v_retry_rate    DOUBLE PRECISION;
  v_zero_hit      DOUBLE PRECISION;
  v_open_conf     INT;

  v_skill_num     DOUBLE PRECISION;
  v_skill_den     DOUBLE PRECISION;
BEGIN
  -- ---- valence: recency-weighted outcome balance over 72h ----
  WITH e AS (
    SELECT
      CASE outcome
        WHEN 'success' THEN  1.0
        WHEN 'partial' THEN  0.2
        WHEN 'failure' THEN -1.0
        ELSE 0.0
      END AS score,
      EXP(- EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 / 24.0) AS w
    FROM experiences
    WHERE created_at > NOW() - (v_valence_window_h || ' hours')::INTERVAL
  ),
  agg AS (SELECT SUM(w * score) AS num, SUM(w) AS den FROM e)
  SELECT COALESCE(num / NULLIF(den, 0), 0) INTO v_valence FROM agg;
  v_valence := GREATEST(-1, LEAST(1, COALESCE(v_valence, 0)));

  -- ---- arousal: event_rate + tool_diversity + novel_stimuli ----
  SELECT COUNT(*)::DOUBLE PRECISION / v_event_rate_min INTO v_event_rate
  FROM memory_events
  WHERE created_at > NOW() - (v_event_rate_min || ' minutes')::INTERVAL;

  SELECT COUNT(DISTINCT t)::DOUBLE PRECISION / 10.0 INTO v_tool_div
  FROM experiences e2, UNNEST(COALESCE(e2.tools_used, ARRAY[]::TEXT[])) t
  WHERE e2.created_at > NOW() - INTERVAL '60 minutes';

  SELECT COUNT(*)::DOUBLE PRECISION / 20.0 INTO v_novel_stim
  FROM stimuli
  WHERE status = 'new'
    AND collected_at > NOW() - INTERVAL '6 hours';

  v_arousal := GREATEST(0, LEAST(1,
      0.5 * LEAST(COALESCE(v_event_rate, 0), 1.0)
    + 0.3 * LEAST(COALESCE(v_tool_div,   0), 1.0)
    + 0.2 * LEAST(COALESCE(v_novel_stim, 0), 1.0)
  ));

  -- ---- curiosity ----
  SELECT COUNT(*) INTO v_empty FROM memory_events
  WHERE event_type = 'recalled'
    AND COALESCE((context->>'hits')::INT, 0) = 0
    AND created_at > NOW() - (v_curiosity_h || ' hours')::INTERVAL;

  SELECT COUNT(*) INTO v_lowconf FROM memory_events
  WHERE event_type = 'recalled'
    AND COALESCE((context->>'score')::DOUBLE PRECISION, 0) < 0.4
    AND created_at > NOW() - (v_curiosity_h || ' hours')::INTERVAL;

  WITH gap_data AS (
    SELECT
      COUNT(*) FILTER (WHERE NOT reflected) AS unreflected,
      GREATEST(1, COUNT(*))                 AS total
    FROM experiences
    WHERE created_at > NOW() - INTERVAL '48 hours'
  )
  SELECT unreflected::DOUBLE PRECISION / total INTO v_cluster_gaps FROM gap_data;

  v_curiosity := GREATEST(0, LEAST(1,
      v_curiosity_base
    + 0.02 * COALESCE(v_empty, 0)
    + 0.01 * COALESCE(v_lowconf, 0)
    + 0.30 * COALESCE(v_cluster_gaps, 0)
  ));

  -- ---- satisfaction ----
  WITH s AS (
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'success')::DOUBLE PRECISION
        / GREATEST(1, COUNT(*)) AS rate
    FROM experiences
    WHERE created_at > NOW() - (v_satisfaction_h || ' hours')::INTERVAL
  )
  SELECT rate INTO v_succ_rate FROM s;

  WITH p AS (
    SELECT
      COUNT(*) FILTER (WHERE user_sentiment IN ('pleased', 'delighted'))::DOUBLE PRECISION
        / GREATEST(1, COUNT(*) FILTER (WHERE user_sentiment IS NOT NULL)) AS pr
    FROM experiences
    WHERE created_at > NOW() - (v_satisfaction_h || ' hours')::INTERVAL
  )
  SELECT pr INTO v_pleased FROM p;

  v_useful_delta :=
    (SELECT COUNT(*) FROM memory_events
       WHERE event_type = 'mark_useful'
         AND created_at > NOW() - (v_useful_short_h || ' hours')::INTERVAL)
    -
    (SELECT COUNT(*) FROM memory_events
       WHERE event_type = 'mark_useful'
         AND created_at BETWEEN NOW() - (v_useful_long_h  || ' hours')::INTERVAL
                            AND NOW() - (v_useful_short_h || ' hours')::INTERVAL);

  v_satisfaction := GREATEST(0, LEAST(1,
      0.60 * COALESCE(v_succ_rate, 0)
    + 0.30 * COALESCE(v_pleased,   0)
    + 0.05 * TANH(COALESCE(v_useful_delta, 0)::DOUBLE PRECISION / 5.0)
    + 0.05
  ));

  -- ---- frustration ----
  WITH r AS (
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'agent_error')::DOUBLE PRECISION
        / GREATEST(1, COUNT(*) FILTER (WHERE event_type = 'agent_completed')) AS rate
    FROM memory_events
    WHERE created_at > NOW() - (v_frustration_h || ' hours')::INTERVAL
  )
  SELECT rate INTO v_retry_rate FROM r;

  WITH z AS (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE((context->>'hits')::INT, 0) = 0)::DOUBLE PRECISION
        / GREATEST(1, COUNT(*)) AS rate
    FROM memory_events
    WHERE event_type = 'recalled'
      AND created_at > NOW() - (v_frustration_h || ' hours')::INTERVAL
  )
  SELECT rate INTO v_zero_hit FROM z;

  -- open_conflicts: contradiction_detected events without a matching
  -- contradiction_resolved (same trace_id) within the window.
  SELECT COUNT(*) INTO v_open_conf
  FROM memory_events d
  WHERE d.event_type = 'contradiction_detected'
    AND d.trace_id IS NOT NULL
    AND d.created_at > NOW() - (v_open_conf_h || ' hours')::INTERVAL
    AND NOT EXISTS (
      SELECT 1 FROM memory_events r
      WHERE r.event_type = 'contradiction_resolved'
        AND r.trace_id = d.trace_id
    );

  v_frustration := GREATEST(0, LEAST(1,
      0.40 * COALESCE(v_retry_rate, 0)
    + 0.40 * COALESCE(v_zero_hit,   0)
    + 0.05 * LEAST(COALESCE(v_open_conf, 0), 4)
  ));

  -- ---- confidence ----
  -- weighted skill success rate over 48h. Falls back to previous value when
  -- no skill activity (idle agents shouldn't crash to 0).
  WITH s AS (
    SELECT
      n,
      outcome,
      EXP(- EXTRACT(EPOCH FROM (NOW() - last_at)) / 3600.0 / 48.0) AS w
    FROM skill_outcomes
    WHERE last_at > NOW() - (v_confidence_h || ' hours')::INTERVAL
  )
  SELECT
    COALESCE(SUM(n * w) FILTER (WHERE outcome = 'success'), 0),
    COALESCE(SUM(n * w),                                    0)
  INTO v_skill_num, v_skill_den
  FROM s;

  IF v_skill_den > 0 THEN
    v_confidence := GREATEST(0, LEAST(1, v_skill_num / v_skill_den));
  ELSE
    SELECT confidence INTO v_prev_conf FROM agent_affect WHERE id = 1;
    v_confidence := COALESCE(v_prev_conf, 0.5);
  END IF;

  -- ---- assemble ----
  RETURN jsonb_build_object(
    'curiosity',    v_curiosity,
    'frustration',  v_frustration,
    'satisfaction', v_satisfaction,
    'confidence',   v_confidence,
    'valence',      v_valence,
    'arousal',      v_arousal,
    'computed_at',  NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION compute_affect() TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 4. apply_compute_affect(p_trigger) — wrapper that patches agent_affect
--    singleton AND appends to agent_affect_history. This is the only writer
--    going forward; the legacy affect_apply() is left in place as a
--    backward-compat shim until the MCP tools stop calling it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_compute_affect(p_trigger TEXT DEFAULT 'manual')
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v JSONB;
BEGIN
  v := compute_affect();

  UPDATE agent_affect SET
    curiosity    = (v->>'curiosity')::DOUBLE PRECISION,
    frustration  = (v->>'frustration')::DOUBLE PRECISION,
    satisfaction = (v->>'satisfaction')::DOUBLE PRECISION,
    confidence   = (v->>'confidence')::DOUBLE PRECISION,
    valence      = (v->>'valence')::DOUBLE PRECISION,
    arousal      = (v->>'arousal')::DOUBLE PRECISION,
    updated_at   = NOW(),
    last_event   = 'compute_affect:' || p_trigger
  WHERE id = 1;

  IF NOT FOUND THEN
    INSERT INTO agent_affect (
      id, curiosity, frustration, satisfaction, confidence, valence, arousal, last_event
    ) VALUES (
      1,
      (v->>'curiosity')::DOUBLE PRECISION,
      (v->>'frustration')::DOUBLE PRECISION,
      (v->>'satisfaction')::DOUBLE PRECISION,
      (v->>'confidence')::DOUBLE PRECISION,
      (v->>'valence')::DOUBLE PRECISION,
      (v->>'arousal')::DOUBLE PRECISION,
      'compute_affect:' || p_trigger
    );
  END IF;

  INSERT INTO agent_affect_history (
    curiosity, frustration, satisfaction, confidence, valence, arousal,
    source, trigger_event
  ) VALUES (
    (v->>'curiosity')::DOUBLE PRECISION,
    (v->>'frustration')::DOUBLE PRECISION,
    (v->>'satisfaction')::DOUBLE PRECISION,
    (v->>'confidence')::DOUBLE PRECISION,
    (v->>'valence')::DOUBLE PRECISION,
    (v->>'arousal')::DOUBLE PRECISION,
    'compute_affect',
    p_trigger
  );

  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_compute_affect(TEXT) TO anon, service_role;

-- ---------------------------------------------------------------------------
-- 5. Triggers — two writers, no cron, per the spec.
-- ---------------------------------------------------------------------------

-- 5a. After every experiences INSERT — keeps valence/satisfaction/confidence
-- fresh. Cheap because experience writes are infrequent.
CREATE OR REPLACE FUNCTION trg_compute_affect_on_experience()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM apply_compute_affect('experiences:' || COALESCE(NEW.outcome, 'unknown'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS experiences_compute_affect ON experiences;
CREATE TRIGGER experiences_compute_affect
  AFTER INSERT ON experiences
  FOR EACH ROW
  EXECUTE FUNCTION trg_compute_affect_on_experience();

-- 5b. After memory_events INSERT of whitelisted types. Keeps
-- arousal/curiosity/frustration fresh. The whitelist is exactly the events
-- that drive the formulas — random 'note' or 'created' events do NOT
-- recompute (would be wasteful and flap the mood disc).
CREATE OR REPLACE FUNCTION trg_compute_affect_on_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_type IN (
    'recalled', 'agent_error', 'agent_completed',
    'mark_useful', 'contradiction_detected'
  ) THEN
    PERFORM apply_compute_affect('memory_events:' || NEW.event_type);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_events_compute_affect ON memory_events;
CREATE TRIGGER memory_events_compute_affect
  AFTER INSERT ON memory_events
  FOR EACH ROW
  EXECUTE FUNCTION trg_compute_affect_on_event();

-- ---------------------------------------------------------------------------
-- 6. Sanity check — refuses to commit a broken function.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v JSONB;
BEGIN
  v := compute_affect();
  IF v IS NULL THEN
    RAISE EXCEPTION '062 sanity: compute_affect() returned NULL';
  END IF;
  IF NOT (v ? 'valence' AND v ? 'arousal' AND v ? 'curiosity'
       AND v ? 'frustration' AND v ? 'satisfaction' AND v ? 'confidence') THEN
    RAISE EXCEPTION '062 sanity: compute_affect() result missing keys: %', v;
  END IF;
  -- valence range
  IF (v->>'valence')::DOUBLE PRECISION < -1 OR (v->>'valence')::DOUBLE PRECISION > 1 THEN
    RAISE EXCEPTION '062 sanity: valence out of [-1,1]: %', v->>'valence';
  END IF;
  -- arousal/curiosity/frustration/satisfaction/confidence each in [0,1]
  PERFORM 1 FROM (VALUES ('arousal'),('curiosity'),('frustration'),('satisfaction'),('confidence')) AS k(name)
  WHERE (v->>k.name)::DOUBLE PRECISION < 0 OR (v->>k.name)::DOUBLE PRECISION > 1;
  IF FOUND THEN
    RAISE EXCEPTION '062 sanity: a [0,1] dimension out of range: %', v;
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
