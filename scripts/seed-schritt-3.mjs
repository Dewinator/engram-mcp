#!/usr/bin/env node
// seed-schritt-3.mjs — one-shot seed for the 'vectormemory-schritt-3' project.
//
// Persists today's architectural decisions, lesson, open intention and the
// day's experience into the shared Supabase pool, scoped to the new project.
// Safe to re-run: create_project is idempotent via unique slug, and
// MemoryService.create() dedups near-duplicates by cosine similarity.
//
// Why this isn't SQL: MemoryService.create() generates embeddings via Ollama,
// seeds Hebbian links, and applies interference. Doing that in psql would
// mean embedding-less rows and skipped affect feedback — not acceptable for
// a first seed.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpCfg = JSON.parse(await fs.readFile(path.resolve(__dirname, "../.mcp.json"), "utf8"));
const env = mcpCfg.mcpServers["vector-memory"].env;
for (const k of Object.keys(env)) process.env[k] ||= env[k];

const DIST = path.resolve(__dirname, "../mcp-server/dist");
const { MemoryService }     = await import(path.join(DIST, "services/supabase.js"));
const { ExperienceService } = await import(path.join(DIST, "services/experiences.js"));
const { ProjectService }    = await import(path.join(DIST, "services/projects.js"));
const { createEmbeddingProvider } = await import(path.join(DIST, "services/embeddings.js"));

const SLUG = "vectormemory-schritt-3";

const embeddings  = createEmbeddingProvider();
const memories    = new MemoryService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, embeddings);
const experiences = new ExperienceService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, embeddings);
const projects    = new ProjectService(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// -------- 1. create project (idempotent) --------
let project = await projects.getBySlug(SLUG);
if (!project) {
  project = await projects.create(
    SLUG,
    "Vectormemory Schritt 3 — Tool-Discovery",
    "Dynamische Tool-Registrierung via Vektorsuche, damit smalle Modelle (Qwen3 8B, 16k ctx) mit minimal-Profile arbeiten und trotzdem Zugriff auf alle openClaw-Tools haben. Ziel: Markdown-Bootstrap auf ein Minimum reduzieren, Seele/Wissen/Kontext komplett über vectormemory beziehen.",
    { created_by: "claude-code-seed", related_repos: ["vectormemory-openclaw", "openclaw"] }
  );
  console.log("Created project:", project.slug, project.id);
} else {
  console.log("Project exists:", project.slug, project.id);
}
const projectId = project.id;

// -------- 2. decisions (remember) --------
const decisions = [
  {
    content:
      "Qwen3 8B Fast 16k (Tag qwen3-fast:8b-16k) ist der konfigurierte lokale Fallback-Agent openClaw-seitig als 'qwen3-local'. num_ctx wurde via Modelfile von 32768 auf 16384 reduziert, weil das Original-Modelfile auf 32k gebackt war und auf dem 16GB M4 zu Swap/Timeout führte. Main-Agent bleibt openai-codex/gpt-5.4-mini.",
    tags: ["qwen3", "ollama", "decision", "local-model"],
  },
  {
    content:
      "Claude Code CLI hat seit 2026-04-20 über ~/.claude.json eine eigene MCP-Anbindung an vector-memory (OPENCLAW_TOOL_PROFILE=full). Shared memory pool mit openClaw über dieselbe Supabase-Instanz. User ist sich der Cloud-Konsequenz bewusst und akzeptiert sie.",
    tags: ["mcp", "claude-code", "architecture", "shared-pool"],
  },
  {
    content:
      "qwen3-local Agent läuft temporär mit profile:minimal + alsoAllow [message, agents_list, memory_search, memory_get] + fs. Hat damit KEINEN Zugriff auf die vector-memory MCP-Tools. Das ist bewusst übergangsweise, bis Schritt 3 (dynamische Tool-Discovery) steht — dann kann minimal+16k trotzdem vollständig arbeiten.",
    tags: ["openclaw", "tool-profile", "temporary", "decision"],
  },
  {
    content:
      "Migration 045_projects.sql führt first-class Projekt-Entität ein mit nullable project_id FK auf memories/experiences/intentions/lessons, plus agent_active_project-Tabelle für pro-Agent Scope. Auto-Scoping auf Writes, Reads bleiben global (explizit via project_brief scopen). Dashboard-Tab 'projekte' mit Copy-Prompt-Button schließt den UX-Loop für User → Agent-Kontext-Routing.",
    tags: ["migration-045", "architecture", "project-scoping", "dashboard"],
  },
];

for (const d of decisions) {
  const m = await memories.create({
    content: d.content,
    category: "decisions",
    tags: d.tags,
    source: "seed-schritt-3",
    importance: 0.8,
    project_id: projectId,
  });
  console.log("  remember:", m.id, "—", m.content.slice(0, 70) + "…");
}

// -------- 3. lesson (record_lesson + scope) --------
// Zunächst eine source experience als Anker, damit die lesson source_ids hat.
const anchorExp = await experiences.record({
  summary:
    "Debugging 2026-04-20: Qwen3 Latenz analysiert, num_ctx von 32k auf 16k reduziert, Claude Code MCP angebunden, Migration 045 für Projekt-Scoping gebaut.",
  task_type: "architecture",
  outcome: "success",
  difficulty: 0.6,
  valence: 0.5,
  arousal: 0.4,
  tags: ["qwen3", "mcp", "architecture", "projects-migration"],
  what_worked:
    "Root-Cause-Analyse über ollama ps + memory_pressure + Gateway-Logs. Klarheit geschaffen, dass minimal-profile MCPs filtert und full-profile bei 16k ctx nicht passt.",
  what_failed:
    "Initialer Versuch, vector-memory__*-Tools via alsoAllow zu whitelisten — Format wird vom Parser verworfen.",
  tools_used: ["ollama", "psql", "supabase", "node", "mcp"],
});
await projects.applyScopeToRow("experiences", anchorExp.id, projectId);
console.log("  experience:", anchorExp.id);

const lessonId = await experiences.recordLesson(
  "openClaws tool-profile 'minimal' filtert MCP-Tools vollständig. alsoAllow akzeptiert keine MCP-prefixed Namen im Format server__tool (werden als unknown entries verworfen, Log-Warnung). 'full' Profile exponiert ~75 Tools (15-25k Token Schema-Prefill) und passt nicht in 16k Context. Diese Asymmetrie ist die strukturelle Motivation für dynamische Tool-Discovery: smalle Modelle brauchen minimal-ctx + semantischen Tool-Lookup statt statischer Schema-Registrierung.",
  [anchorExp.id],
  { category: "insight", confidence: 0.8 }
);
await projects.applyScopeToRow("lessons", lessonId, projectId);
console.log("  lesson:", lessonId);

// -------- 4. open intention (set_intention + scope) --------
const intentionId = await experiences.setIntention({
  intention:
    "Schritt 3 umsetzen: (a) Tool-Indexer-Script, das openClaws ~75 Tools in memories mit category='tool' einspeist (Content=Beschreibung + Use-Cases, Metadata=Schema). (b) Neues MCP-Tool find_tool(intent) als thin wrapper um recall mit Kategorie-Filter. (c) AGENTS.md des qwen3-local Workspace radikal kürzen auf ~20 Zeilen Minimal-Bootstrap. (d) SOUL.md/USER.md/MEMORY.md über import_markdown migrieren.",
  priority: 0.85,
});
await projects.applyScopeToRow("intentions", intentionId, projectId);
console.log("  intention:", intentionId);

// -------- 5. done --------
console.log("\nSeed complete. Brief:");
const brief = await projects.brief(SLUG);
console.log("  memories:      ", brief.counts.memories);
console.log("  experiences:   ", brief.counts.experiences);
console.log("  intentions:    ", brief.counts.intentions_open + "/" + brief.counts.intentions_total);
console.log("  lessons:       ", brief.counts.lessons);
console.log("\nNext: open dashboard → tab 'projekte' → '" + SLUG + "' → prompt kopieren.");
