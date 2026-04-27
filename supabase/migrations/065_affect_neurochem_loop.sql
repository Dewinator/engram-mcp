-- Migration 065 — close the affect → neurochemistry reverse loop.
--
-- Phase 3 of issue #11 (commit c031a3c) removed the legacy `affect_apply()`
-- write path from MCP tools because the trigger-based compute_affect()
-- overwrites whatever the LLM pushes. That severance had a side effect we
-- only saw once telemetry landed (mig 064): the 3-system neurochemistry
-- (mig 042 — dopamine/serotonin/noradrenaline on agent_neurochemistry)
-- USED to be fed indirectly via the MCP tools' affect_apply() calls,
-- because affect_apply() ends with `PERFORM neurochem_apply(...)`. With
-- those calls gone, the active code path no longer drives neurochemistry
-- at all — the `main` row drifted to noradrenaline=1.0 saturation and
-- only updates from peripheral processes (motivation sidecar etc).
--
-- This migration restores the loop on the *new* authoritative side:
-- whenever apply_compute_affect() patches agent_affect from observables,
-- it ALSO translates the trigger label to a neurochem event and applies
-- it. Two design constraints:
--
-- 1. Only outcome-bearing trigger events feed neurochem. Recall events
--    fire too often and would saturate the dopamine TD-error. The
--    whitelist mirrors what affect_apply() used to translate.
-- 2. The call is best-effort — if neurochem_apply throws (genome `main`
--    missing, RLS, etc.) we swallow the error so the affect trigger
--    itself never breaks downstream INSERTs.

BEGIN;

CREATE OR REPLACE FUNCTION apply_neurochem_from_trigger(p_trigger TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_event   TEXT;
  v_outcome DOUBLE PRECISION;
BEGIN
  -- High-frequency events (recalled, mark_useful) intentionally drop through
  -- to the ELSE branch — we don't want every recall to nudge dopamine.
  CASE p_trigger
    -- experiences trigger labels (mig 062 trg_compute_affect_on_experience)
    WHEN 'experiences:success' THEN v_event := 'task_complete';   v_outcome := 0.8;
    WHEN 'experiences:partial' THEN v_event := 'familiar_task';   v_outcome := 0.5;
    WHEN 'experiences:failure' THEN v_event := 'task_failed';     v_outcome := 0.2;
    WHEN 'experiences:unknown' THEN v_event := 'novel_stimulus';  v_outcome := NULL;

    -- memory_events trigger labels (mig 062 trg_compute_affect_on_event)
    WHEN 'memory_events:agent_completed'        THEN v_event := 'task_complete';  v_outcome := 0.8;
    WHEN 'memory_events:agent_error'            THEN v_event := 'error';          v_outcome := 0.2;
    WHEN 'memory_events:contradiction_detected' THEN v_event := 'error';          v_outcome := 0.3;

    ELSE RETURN;
  END CASE;

  BEGIN
    PERFORM neurochem_apply('main', v_event, v_outcome, 1.0);
  EXCEPTION WHEN OTHERS THEN
    -- Best-effort: do not propagate failure into the affect trigger chain.
    NULL;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_neurochem_from_trigger(TEXT) TO anon, service_role;

-- Patch apply_compute_affect to call the new translator after writing
-- agent_affect_history. Body stays identical except for the trailing
-- PERFORM line and the removal of the noisy DECLARE — keeping the diff
-- minimal to make review obvious.
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

  -- mig 065 — close the loop back to the 3-system neurochemistry. No-op
  -- for high-frequency triggers (recalled, mark_useful) and for non-main
  -- callers that don't have a 'main' genome.
  PERFORM apply_neurochem_from_trigger(p_trigger);

  RETURN v;
END;
$$;

-- Sanity check — apply_compute_affect must still return a populated JSONB
-- after the loop addition. Refuses to commit a broken function.
DO $$
DECLARE v JSONB;
BEGIN
  v := apply_compute_affect('mig065-sanity');
  IF v IS NULL OR NOT (v ? 'valence' AND v ? 'arousal') THEN
    RAISE EXCEPTION '065 sanity: apply_compute_affect returned %', v;
  END IF;
END;
$$;

COMMIT;
