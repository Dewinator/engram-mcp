import { z } from "zod";
import type { ProjectService, ProjectStatus } from "../services/projects.js";

// Slug validator — keep in sync with the DB CHECK constraint in migration 045.
const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, "slug must be lowercase kebab-case, 2–64 chars, no leading/trailing dash")
  .describe("Project slug — short stable identifier used as handle everywhere (e.g. 'vectormemory-schritt-3').");

const statusSchema = z
  .enum(["active", "paused", "completed", "archived"])
  .describe("Project lifecycle state.");

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

export const createProjectSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).describe("Human-readable project name."),
  description: z
    .string()
    .optional()
    .default("")
    .describe("One-paragraph description of what this project is about — shown in dashboard cards."),
  metadata: z
    .record(z.unknown())
    .optional()
    .default({})
    .describe("Arbitrary JSON metadata (links, tags, custom fields)."),
});

export async function createProject(
  service: ProjectService,
  input: z.infer<typeof createProjectSchema>
) {
  const p = await service.create(input.slug, input.name, input.description ?? "", input.metadata ?? {});
  return {
    content: [{
      type: "text" as const,
      text: `Created project '${p.slug}' (${p.name}) · id=${p.id}\nStatus: ${p.status}\n${p.description ? `\n${p.description}\n` : ""}\nNext: call set_active_project('${p.slug}') so new memories/experiences are auto-scoped.`,
    }],
  };
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

export const listProjectsSchema = z.object({
  status: statusSchema.optional().describe("Filter by status — omit for all."),
});

export async function listProjects(
  service: ProjectService,
  input: z.infer<typeof listProjectsSchema>
) {
  const rows = await service.listWithActivity(input.status);
  if (rows.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: input.status
          ? `No projects with status='${input.status}'.`
          : `No projects yet. Use create_project to add the first.`,
      }],
    };
  }
  const lines = rows.map((p) => {
    const last = p.last_activity.slice(0, 10);
    return `- ${p.slug.padEnd(32)} [${p.status.padEnd(9)}] ${p.name}\n    mem=${p.memory_count}  exp=${p.experience_count}  open_int=${p.open_intentions}  lessons=${p.lesson_count}  last=${last}`;
  });
  const header = input.status ? `Projects (status=${input.status}):` : "Projects (all):";
  return { content: [{ type: "text" as const, text: `${header}\n\n${lines.join("\n")}` }] };
}

// ---------------------------------------------------------------------------
// get_project
// ---------------------------------------------------------------------------

export const getProjectSchema = z.object({ slug: slugSchema });

export async function getProject(
  service: ProjectService,
  input: z.infer<typeof getProjectSchema>
) {
  const p = await service.getBySlug(input.slug);
  if (!p) {
    return { content: [{ type: "text" as const, text: `No project with slug '${input.slug}'.` }] };
  }
  const lines = [
    `Project: ${p.slug}`,
    `Name:    ${p.name}`,
    `Status:  ${p.status}`,
    `Created: ${p.created_at.slice(0, 10)}`,
    `Updated: ${p.updated_at.slice(0, 10)}`,
    ``,
    p.description || "(no description)",
  ];
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    lines.push("", "Metadata:", JSON.stringify(p.metadata, null, 2));
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// project_brief — condensed priming payload
// ---------------------------------------------------------------------------

export const projectBriefSchema = z.object({
  slug: slugSchema.describe("Project to brief. This is the single call an agent makes when a user says 'work on X'."),
});

export async function projectBrief(
  service: ProjectService,
  input: z.infer<typeof projectBriefSchema>
) {
  const b = await service.brief(input.slug);
  if (!b.exists) {
    return { content: [{ type: "text" as const, text: `No project with slug '${input.slug}'.` }] };
  }
  const p = b.project!;
  const c = b.counts!;
  const header = [
    `# ${p.name}  (${p.slug})  [${p.status}]`,
    p.description ? `\n${p.description}\n` : "",
    `Memories: ${c.memories}  ·  Experiences: ${c.experiences}  ·  Open intentions: ${c.intentions_open}/${c.intentions_total}  ·  Lessons: ${c.lessons}`,
  ].join("\n");

  const intentions = (b.open_intentions ?? []).map((i: any, n: number) => {
    const prog = typeof i.progress === "number" ? ` (${Math.round(i.progress * 100)}%)` : "";
    const prio = typeof i.priority === "number" ? `  prio=${i.priority.toFixed(2)}` : "";
    return `${n + 1}. ${i.intention}${prog}${prio}`;
  });
  const experiences = (b.recent_experiences ?? []).map((e: any, n: number) => {
    const out = e.outcome ? `[${e.outcome}]` : "";
    const tt = e.task_type ? ` ${e.task_type}` : "";
    return `${n + 1}. ${out}${tt}  ${(e.summary ?? "").slice(0, 120)}`;
  });
  const memories = (b.key_memories ?? []).map((m: any, n: number) => {
    const pin = m.pinned ? "📌 " : "";
    return `${n + 1}. ${pin}[${m.category}] ${(m.content ?? "").slice(0, 140)}`;
  });
  const lessons = (b.top_lessons ?? []).map((l: any, n: number) => {
    return `${n + 1}. (n=${l.evidence_count}) ${(l.lesson ?? "").slice(0, 160)}`;
  });

  const sections: string[] = [header];
  if (intentions.length) sections.push("\n## Open intentions\n" + intentions.join("\n"));
  if (experiences.length) sections.push("\n## Recent experiences\n" + experiences.join("\n"));
  if (memories.length) sections.push("\n## Key memories\n" + memories.join("\n"));
  if (lessons.length) sections.push("\n## Top lessons\n" + lessons.join("\n"));

  return { content: [{ type: "text" as const, text: sections.join("\n") }] };
}

// ---------------------------------------------------------------------------
// set_active_project
// ---------------------------------------------------------------------------

export const setActiveProjectSchema = z.object({
  slug: slugSchema,
  agent: z
    .string()
    .optional()
    .default("main")
    .describe("Agent genome label. Defaults to 'main'. All subsequent writes from this agent that omit an explicit project will be scoped here."),
});

export async function setActiveProject(
  service: ProjectService,
  input: z.infer<typeof setActiveProjectSchema>
) {
  const res = await service.setActive(input.agent ?? "main", input.slug);
  if (!res.ok) {
    return { content: [{ type: "text" as const, text: `Failed: ${res.error ?? "unknown error"}` }] };
  }
  return {
    content: [{
      type: "text" as const,
      text: `Active project set: agent='${input.agent ?? "main"}' → project='${input.slug}'\nNew memories, experiences, intentions and lessons from this agent will be auto-scoped unless an explicit project is passed.`,
    }],
  };
}

// ---------------------------------------------------------------------------
// update_project_status
// ---------------------------------------------------------------------------

export const updateProjectStatusSchema = z.object({
  slug: slugSchema,
  status: statusSchema,
});

export async function updateProjectStatus(
  service: ProjectService,
  input: z.infer<typeof updateProjectStatusSchema>
) {
  const p = await service.updateStatus(input.slug, input.status);
  return {
    content: [{
      type: "text" as const,
      text: `Project '${p.slug}' status: ${p.status}`,
    }],
  };
}

// ---------------------------------------------------------------------------
// link_to_project — attach an existing row to a project (or unlink)
// ---------------------------------------------------------------------------

export const linkToProjectSchema = z.object({
  table: z.enum(["memories", "experiences", "intentions", "lessons"]),
  row_id: z.string().uuid().describe("UUID of the row to link."),
  slug: slugSchema.nullable().describe("Target project slug, or null to unlink."),
});

export async function linkToProject(
  service: ProjectService,
  input: z.infer<typeof linkToProjectSchema>
) {
  await service.linkRow(input.table, input.row_id, input.slug);
  return {
    content: [{
      type: "text" as const,
      text: input.slug
        ? `Linked ${input.table}/${input.row_id} → project '${input.slug}'.`
        : `Unlinked ${input.table}/${input.row_id} (now global).`,
    }],
  };
}
