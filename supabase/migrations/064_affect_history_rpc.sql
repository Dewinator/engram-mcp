-- Migration 064 — affect_history RPCs for the tuning-telemetry surface.
--
-- Issue #11 phase 10 (post-observation tuning pass) needs a data-backed
-- view of how compute_affect() actually behaves over time before we touch
-- the constants in compute_affect(). agent_affect_history (mig 062 + 063
-- grants) has the rows; this migration exposes two read-only RPCs:
--
--   1. affect_history_series(p_hours, p_bucket_minutes)
--      Aggregated time-series for charting — average each dimension per
--      bucket. Returns the last p_hours of compute_affect rows.
--
--   2. affect_history_triggers(p_hours)
--      Per-trigger_event breakdown — which event types are firing
--      compute_affect(), how often, and what affect they produce on
--      average. This is the actual tuning input: weights that look right
--      in isolation can still misfire when one trigger dominates.
--
-- Both RPCs are STABLE, return JSONB, and are GRANTed to anon so the
-- dashboard server (which uses the service-role JWT but goes through the
-- same PostgREST surface) can hit them. snapshot rows are excluded — they
-- represent the pre-pivot anchor, not live compute_affect output.

BEGIN;

CREATE OR REPLACE FUNCTION affect_history_series(
  p_hours          INT DEFAULT 168,
  p_bucket_minutes INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  WITH params AS (
    SELECT GREATEST(1, p_hours)              AS hours,
           GREATEST(1, p_bucket_minutes)     AS bucket_min
  ),
  windowed AS (
    SELECT h.*
    FROM agent_affect_history h, params p
    WHERE h.source = 'compute_affect'
      AND h.computed_at >= NOW() - (p.hours || ' hours')::interval
  ),
  bucketed AS (
    SELECT
      to_timestamp(
        floor(extract(epoch FROM w.computed_at) / (p.bucket_min * 60))
        * (p.bucket_min * 60)
      ) AS bucket_at,
      avg(w.curiosity)    AS curiosity,
      avg(w.frustration)  AS frustration,
      avg(w.satisfaction) AS satisfaction,
      avg(w.confidence)   AS confidence,
      avg(w.valence)      AS valence,
      avg(w.arousal)      AS arousal,
      count(*)            AS samples
    FROM windowed w, params p
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'hours',          (SELECT hours FROM params),
    'bucket_minutes', (SELECT bucket_min FROM params),
    'series',         COALESCE(jsonb_agg(jsonb_build_object(
                        'at',           bucket_at,
                        'curiosity',    curiosity,
                        'frustration',  frustration,
                        'satisfaction', satisfaction,
                        'confidence',   confidence,
                        'valence',      valence,
                        'arousal',      arousal,
                        'samples',      samples
                      ) ORDER BY bucket_at), '[]'::jsonb),
    'total_samples',  COALESCE(sum(samples), 0)
  )
  FROM bucketed;
$$;

CREATE OR REPLACE FUNCTION affect_history_triggers(p_hours INT DEFAULT 168)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  WITH windowed AS (
    SELECT *
    FROM agent_affect_history
    WHERE source = 'compute_affect'
      AND computed_at >= NOW() - (GREATEST(1, p_hours) || ' hours')::interval
  ),
  by_trigger AS (
    SELECT
      COALESCE(trigger_event, '(none)') AS trigger_event,
      count(*)                          AS fires,
      avg(curiosity)                    AS avg_curiosity,
      avg(frustration)                  AS avg_frustration,
      avg(satisfaction)                 AS avg_satisfaction,
      avg(confidence)                   AS avg_confidence,
      avg(valence)                      AS avg_valence,
      avg(arousal)                      AS avg_arousal,
      max(computed_at)                  AS last_at
    FROM windowed
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'hours',    GREATEST(1, p_hours),
    'triggers', COALESCE(jsonb_agg(jsonb_build_object(
                  'trigger_event',    trigger_event,
                  'fires',            fires,
                  'avg_curiosity',    avg_curiosity,
                  'avg_frustration',  avg_frustration,
                  'avg_satisfaction', avg_satisfaction,
                  'avg_confidence',   avg_confidence,
                  'avg_valence',      avg_valence,
                  'avg_arousal',      avg_arousal,
                  'last_at',          last_at
                ) ORDER BY fires DESC), '[]'::jsonb),
    'total_fires', COALESCE(sum(fires), 0)
  )
  FROM by_trigger;
$$;

GRANT EXECUTE ON FUNCTION affect_history_series(INT, INT) TO anon, service_role;
GRANT EXECUTE ON FUNCTION affect_history_triggers(INT)    TO anon, service_role;

COMMIT;
