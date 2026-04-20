import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Project-scoping layer (introduced 2026-04-20, migration 045).
 *
 * Projects are a coarse organizing primitive above memories/experiences/
 * intentions/lessons. They are opt-in on writes (nullable project_id) and
 * give the user a handle to tell an agent "work on X". The dashboard uses
 * this service to render the projects list and the per-project detail view.
 *
 * Reads in general stay global (project-scoping on recall is explicit at the
 * call site via `project_brief` or an optional project filter).
 */

export type ProjectStatus = "active" | "paused" | "completed" | "archived";

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: ProjectStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithActivity extends ProjectRow {
  memory_count: number;
  experience_count: number;
  open_intentions: number;
  lesson_count: number;
  last_activity: string;
}

export interface ProjectBrief {
  exists: boolean;
  slug?: string;
  project?: ProjectRow;
  counts?: {
    memories: number;
    experiences: number;
    intentions_open: number;
    intentions_total: number;
    lessons: number;
  };
  open_intentions?: Array<Record<string, unknown>>;
  recent_experiences?: Array<Record<string, unknown>>;
  key_memories?: Array<Record<string, unknown>>;
  top_lessons?: Array<Record<string, unknown>>;
}

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export class ProjectService {
  private db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  /** Create a new project. Slug must match ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ (enforced by CHECK). */
  async create(
    slug: string,
    name: string,
    description = "",
    metadata: Record<string, unknown> = {}
  ): Promise<ProjectRow> {
    const { data, error } = await this.db
      .from("projects")
      .insert({ slug, name, description, metadata })
      .select("*")
      .single();
    if (error) throw new Error(`project.create: ${fmtErr(error)}`);
    return data as ProjectRow;
  }

  /** Fetch a project by slug. Returns null if not found. */
  async getBySlug(slug: string): Promise<ProjectRow | null> {
    const { data, error } = await this.db
      .from("projects")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(`project.getBySlug: ${fmtErr(error)}`);
    return (data as ProjectRow) ?? null;
  }

  /** List projects with activity counts. Optionally filter by status. */
  async listWithActivity(status?: ProjectStatus): Promise<ProjectWithActivity[]> {
    const { data, error } = await this.db.rpc("list_projects_with_activity", {
      p_status: status ?? null,
    });
    if (error) throw new Error(`project.list: ${fmtErr(error)}`);
    return (data as ProjectWithActivity[]) ?? [];
  }

  /** Full brief for context priming — header + counts + recent slices. */
  async brief(slug: string): Promise<ProjectBrief> {
    const { data, error } = await this.db.rpc("project_brief", { p_slug: slug });
    if (error) throw new Error(`project.brief: ${fmtErr(error)}`);
    return (data as ProjectBrief) ?? { exists: false, slug };
  }

  /** Update status (active / paused / completed / archived). */
  async updateStatus(slug: string, status: ProjectStatus): Promise<ProjectRow> {
    const { data, error } = await this.db
      .from("projects")
      .update({ status })
      .eq("slug", slug)
      .select("*")
      .single();
    if (error) throw new Error(`project.updateStatus: ${fmtErr(error)}`);
    return data as ProjectRow;
  }

  /** Patch editable fields (name, description, metadata). */
  async patch(
    slug: string,
    patch: Partial<Pick<ProjectRow, "name" | "description" | "metadata">>
  ): Promise<ProjectRow> {
    const { data, error } = await this.db
      .from("projects")
      .update(patch)
      .eq("slug", slug)
      .select("*")
      .single();
    if (error) throw new Error(`project.patch: ${fmtErr(error)}`);
    return data as ProjectRow;
  }

  /** Set the active project for an agent (identified by genome label). */
  async setActive(agentLabel: string, slug: string): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await this.db.rpc("set_active_project", {
      p_label: agentLabel,
      p_slug: slug,
    });
    if (error) throw new Error(`project.setActive: ${fmtErr(error)}`);
    return data as { ok: boolean; error?: string };
  }

  /** Clear the active project for an agent. */
  async clearActive(agentLabel: string): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await this.db.rpc("clear_active_project", {
      p_label: agentLabel,
    });
    if (error) throw new Error(`project.clearActive: ${fmtErr(error)}`);
    return data as { ok: boolean; error?: string };
  }

  /** Resolve the active project UUID for an agent, or null if none set. */
  async activeProjectId(agentLabel = "main"): Promise<string | null> {
    const { data, error } = await this.db.rpc("active_project_for_agent", {
      p_label: agentLabel,
    });
    if (error) throw new Error(`project.activeProjectId: ${fmtErr(error)}`);
    return (data as string | null) ?? null;
  }

  /** Convenience: resolve a slug into its UUID, or null. */
  async resolveSlug(slug: string): Promise<string | null> {
    const { data, error } = await this.db.rpc("project_id_by_slug", { p_slug: slug });
    if (error) throw new Error(`project.resolveSlug: ${fmtErr(error)}`);
    return (data as string | null) ?? null;
  }

  /** Re-scope a single cognitive row (memory/experience/intention/lesson) to a project. */
  async linkRow(
    table: "memories" | "experiences" | "intentions" | "lessons",
    rowId: string,
    slug: string | null
  ): Promise<void> {
    let projectId: string | null = null;
    if (slug !== null) {
      projectId = await this.resolveSlug(slug);
      if (projectId === null) throw new Error(`project.linkRow: unknown slug '${slug}'`);
    }
    const { error } = await this.db.from(table).update({ project_id: projectId }).eq("id", rowId);
    if (error) throw new Error(`project.linkRow(${table}): ${fmtErr(error)}`);
  }

  /**
   * Resolve the effective project_id for a write. Precedence:
   *   1. Explicit `slug` passed by caller (null to force global)
   *   2. Agent's active project (if one is set)
   *   3. null (global, backward-compatible)
   *
   * Use this from write tools (remember, absorb, record_experience, ...) to
   * auto-scope writes when the user set an active project via set_active_project.
   */
  async resolveScope(
    explicitSlug: string | null | undefined,
    agentLabel: string
  ): Promise<string | null> {
    if (explicitSlug === null) return null;
    if (typeof explicitSlug === "string" && explicitSlug.length > 0) {
      const id = await this.resolveSlug(explicitSlug);
      if (id === null) throw new Error(`project.resolveScope: unknown slug '${explicitSlug}'`);
      return id;
    }
    return await this.activeProjectId(agentLabel);
  }

  /** Bulk update project_id on a single row after an RPC-based insert. Idempotent. */
  async applyScopeToRow(
    table: "memories" | "experiences" | "intentions" | "lessons",
    rowId: string,
    projectId: string | null
  ): Promise<void> {
    if (projectId === null) return;
    const { error } = await this.db.from(table).update({ project_id: projectId }).eq("id", rowId);
    if (error) throw new Error(`project.applyScopeToRow(${table}): ${fmtErr(error)}`);
  }
}
