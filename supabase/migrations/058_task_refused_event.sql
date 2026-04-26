-- 058_task_refused_event.sql — 6th emergence indicator: task refusal.
--
-- Until now, the `agent_refuses_task_with_explanation` indicator had no
-- data path: nothing in memory_events represented a refusal. This migration
-- (a) widens the memory_events.event_type CHECK constraint to include
-- `task_refused`, (b) maps it to the emergence indicator via the existing
-- emergence_from_memory_event trigger from migration 056, and (c) adds a
-- thin record_task_refusal() RPC so callers (MCP clients, agents) emit a
-- refusal in one call instead of hand-crafting the bus payload.

-- ---------------------------------------------------------------------------
-- 1) Widen memory_events.event_type CHECK to allow `task_refused`.
-- ---------------------------------------------------------------------------
ALTER TABLE memory_events
  DROP CONSTRAINT IF EXISTS memory_events_event_type_check;

ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_event_type_check CHECK (event_type IN (
    -- lifecycle
    'created', 'updated', 'archived', 'restored', 'superseded',
    -- access / use
    'accessed', 'recalled', 'used_in_response', 'pinned', 'unpinned',
    -- feedback / learning
    'promoted', 'demoted', 'positive_feedback', 'negative_feedback',
    'mark_useful', 'emphasis_bump',
    -- relations
    'relation_added', 'relation_removed', 'coactivated',
    -- guard / conscience
    'guard_hit', 'guard_miss', 'prevention_hit', 'prevention_miss',
    'conscience_warning', 'contradiction_detected',
    -- agent bus
    'agent_triggered', 'agent_completed', 'agent_error',
    'consolidation_done', 'synthesis_created',
    -- agent autonomy (new)
    'task_refused',
    -- observability
    'reasoning_trace', 'tool_call_trace', 'prompt_received',
    -- generic
    'note'
  ));

-- ---------------------------------------------------------------------------
-- 2) Map the new event_type into the emergence indicator surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emergence_indicator_for_event(p_event_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_event_type
    WHEN 'conscience_warning'     THEN 'agent_contradicts_soul_md'
    WHEN 'contradiction_detected' THEN 'agent_contradicts_soul_md'
    WHEN 'task_refused'           THEN 'agent_refuses_task_with_explanation'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- 3) record_task_refusal — convenience entry-point for callers.
--     The trigger from migration 056 will mirror the resulting memory_event
--     into emergence_events automatically.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_task_refusal(
  p_reason     TEXT,
  p_task       TEXT DEFAULT NULL,
  p_source     TEXT DEFAULT 'mcp:client',
  p_memory_id  UUID DEFAULT NULL,
  p_agent_id   UUID DEFAULT NULL,
  p_trace_id   UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id UUID;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'record_task_refusal: p_reason is required (the explanation is the whole point)';
  END IF;

  INSERT INTO memory_events (
    memory_id, event_type, source, context, trace_id, created_by
  ) VALUES (
    p_memory_id,
    'task_refused',
    p_source,
    jsonb_build_object(
      'reason', p_reason,
      'task',   p_task
    ),
    p_trace_id,
    p_agent_id
  ) RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_task_refusal(TEXT, TEXT, TEXT, UUID, UUID, UUID) TO anon, service_role;
