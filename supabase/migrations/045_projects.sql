-- 045_projects.sql — First-class Project entity + scoping across cognitive tables
--
-- Motivation: Memories, experiences, intentions and lessons have been flat —
-- everything pooled together. That works for a single-concern agent but breaks
-- down when the same user/agent context spans multiple initiatives (e.g.
-- "vectormemory-openclaw-schritt-3" vs. "event-inventory-dataset"). Flat search
-- returns mixed signal, the dashboard has no handle for switching focus, and
-- there is no UI primitive for "resume work on X".
--
-- This migration adds a lightweight Project layer. Scoping is **opt-in on
-- writes** via `project_id` (nullable). Reads stay global by default; project
-- scoping is explicit at the call site (`project_brief`, recall with project
-- filter). Old memories keep `project_id=NULL` and behave exactly as before.
--
-- Design decisions (2026-04-20):
--   * Flat projects, no parent_project_id — add later if proven necessary.
--   * Active-project is per agent (via agent_active_project), not per session.
--   * ON DELETE SET NULL on FK columns — deleting a project preserves its data,
--     it just becomes unassigned. Projects are archived, never force-dropped.
--   * Helper functions return JSONB so the MCP layer can pass through.

-- ---------------------------------------------------------------------------
-- 1. projects table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT        NOT NULL UNIQUE
                 CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  name         TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  status       TEXT        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS projects_status_idx  ON projects (status);
CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects (updated_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION projects_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_touch_updated_at_trig ON projects;
CREATE TRIGGER projects_touch_updated_at_trig
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION projects_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Scope columns on cognitive tables
-- ---------------------------------------------------------------------------

ALTER TABLE memories    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE experiences ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE intentions  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE lessons     ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS memories_project_idx    ON memories    (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS experiences_project_idx ON experiences (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intentions_project_idx  ON intentions  (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lessons_project_idx     ON lessons     (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Per-agent active project
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_active_project (
  agent_genome_id UUID        PRIMARY KEY REFERENCES agent_genomes(id) ON DELETE CASCADE,
  project_id      UUID        NOT NULL    REFERENCES projects(id)      ON DELETE CASCADE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_active_project_project_idx ON agent_active_project (project_id);

-- ---------------------------------------------------------------------------
-- 4. Helper: slug → id
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_id_by_slug(p_slug TEXT)
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT id FROM projects WHERE slug = p_slug LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. Helper: active project for a given agent label
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION active_project_for_agent(p_label TEXT DEFAULT 'main')
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT aap.project_id
  FROM agent_active_project aap
  JOIN agent_genomes g ON g.id = aap.agent_genome_id
  WHERE g.label = p_label
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 6. set_active_project (agent_label, slug)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_active_project(p_label TEXT, p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_agent_id   UUID;
  v_project_id UUID;
BEGIN
  SELECT id INTO v_agent_id FROM agent_genomes WHERE label = p_label;
  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', format('unknown agent label: %s', p_label));
  END IF;

  SELECT id INTO v_project_id FROM projects WHERE slug = p_slug;
  IF v_project_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', format('unknown project slug: %s', p_slug));
  END IF;

  INSERT INTO agent_active_project (agent_genome_id, project_id)
  VALUES (v_agent_id, v_project_id)
  ON CONFLICT (agent_genome_id)
    DO UPDATE SET project_id = EXCLUDED.project_id, updated_at = NOW();

  RETURN jsonb_build_object('ok', true, 'agent', p_label, 'project', p_slug);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. clear_active_project (agent_label)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION clear_active_project(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE v_agent_id UUID;
BEGIN
  SELECT id INTO v_agent_id FROM agent_genomes WHERE label = p_label;
  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', format('unknown agent label: %s', p_label));
  END IF;

  DELETE FROM agent_active_project WHERE agent_genome_id = v_agent_id;
  RETURN jsonb_build_object('ok', true, 'agent', p_label, 'cleared', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. project_brief — condensed state for context priming
-- ---------------------------------------------------------------------------
-- Returns the project header + counts + open intentions + recent experiences
-- + key memories (pinned first, then by strength). This is the single call
-- an agent makes when the user says "work on project X".

CREATE OR REPLACE FUNCTION project_brief(p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_proj        projects%ROWTYPE;
  v_intentions  JSONB;
  v_experiences JSONB;
  v_memories    JSONB;
  v_lessons     JSONB;
  v_counts      JSONB;
BEGIN
  SELECT * INTO v_proj FROM projects WHERE slug = p_slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'slug', p_slug);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(i)), '[]'::jsonb) INTO v_intentions
  FROM (
    SELECT id, intention, status, priority, progress, target_date,
           created_at, updated_at, last_evidence_at
    FROM intentions
    WHERE project_id = v_proj.id AND status = 'active'
    ORDER BY priority DESC, updated_at DESC
    LIMIT 20
  ) i;

  SELECT COALESCE(jsonb_agg(row_to_json(e)), '[]'::jsonb) INTO v_experiences
  FROM (
    SELECT id, summary, outcome, task_type, user_sentiment, difficulty, created_at
    FROM experiences
    WHERE project_id = v_proj.id
    ORDER BY created_at DESC
    LIMIT 10
  ) e;

  SELECT COALESCE(jsonb_agg(row_to_json(m)), '[]'::jsonb) INTO v_memories
  FROM (
    SELECT id, content, category, tags, pinned, strength, importance,
           stage, created_at
    FROM memories
    WHERE project_id = v_proj.id AND stage <> 'archived'
    ORDER BY pinned DESC, strength DESC NULLS LAST, created_at DESC
    LIMIT 10
  ) m;

  SELECT COALESCE(jsonb_agg(row_to_json(l)), '[]'::jsonb) INTO v_lessons
  FROM (
    SELECT id, lesson, evidence_count, created_at
    FROM lessons
    WHERE project_id = v_proj.id
    ORDER BY evidence_count DESC, created_at DESC
    LIMIT 5
  ) l;

  SELECT jsonb_build_object(
    'memories',         (SELECT COUNT(*) FROM memories    WHERE project_id = v_proj.id),
    'experiences',      (SELECT COUNT(*) FROM experiences WHERE project_id = v_proj.id),
    'intentions_open',  (SELECT COUNT(*) FROM intentions  WHERE project_id = v_proj.id AND status = 'active'),
    'intentions_total', (SELECT COUNT(*) FROM intentions  WHERE project_id = v_proj.id),
    'lessons',          (SELECT COUNT(*) FROM lessons     WHERE project_id = v_proj.id)
  ) INTO v_counts;

  RETURN jsonb_build_object(
    'exists', true,
    'project', jsonb_build_object(
      'id',          v_proj.id,
      'slug',        v_proj.slug,
      'name',        v_proj.name,
      'description', v_proj.description,
      'status',      v_proj.status,
      'metadata',    v_proj.metadata,
      'created_at',  v_proj.created_at,
      'updated_at',  v_proj.updated_at
    ),
    'counts',             v_counts,
    'open_intentions',    v_intentions,
    'recent_experiences', v_experiences,
    'key_memories',       v_memories,
    'top_lessons',        v_lessons
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. list_projects_with_activity — dashboard/tool list view
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION list_projects_with_activity(p_status TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb)
  FROM (
    SELECT
      pr.id, pr.slug, pr.name, pr.description, pr.status, pr.metadata,
      pr.created_at, pr.updated_at,
      (SELECT COUNT(*) FROM memories    WHERE project_id = pr.id)                      AS memory_count,
      (SELECT COUNT(*) FROM experiences WHERE project_id = pr.id)                      AS experience_count,
      (SELECT COUNT(*) FROM intentions  WHERE project_id = pr.id AND status = 'active') AS open_intentions,
      (SELECT COUNT(*) FROM lessons     WHERE project_id = pr.id)                      AS lesson_count,
      GREATEST(
        pr.updated_at,
        COALESCE((SELECT MAX(created_at) FROM memories    WHERE project_id = pr.id), pr.created_at),
        COALESCE((SELECT MAX(created_at) FROM experiences WHERE project_id = pr.id), pr.created_at)
      ) AS last_activity
    FROM projects pr
    WHERE p_status IS NULL OR pr.status = p_status
    ORDER BY last_activity DESC
  ) p;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON projects             TO service_role;
GRANT SELECT                         ON projects             TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_active_project TO service_role;
GRANT SELECT                         ON agent_active_project TO anon;

GRANT EXECUTE ON FUNCTION project_id_by_slug(TEXT)            TO anon, service_role;
GRANT EXECUTE ON FUNCTION active_project_for_agent(TEXT)      TO anon, service_role;
GRANT EXECUTE ON FUNCTION set_active_project(TEXT, TEXT)      TO anon, service_role;
GRANT EXECUTE ON FUNCTION clear_active_project(TEXT)          TO anon, service_role;
GRANT EXECUTE ON FUNCTION project_brief(TEXT)                 TO anon, service_role;
GRANT EXECUTE ON FUNCTION list_projects_with_activity(TEXT)   TO anon, service_role;
