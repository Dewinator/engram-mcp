# Projects

**Purpose.** Projects are a coarse organizing handle above the cognitive primitives (`memories`, `experiences`, `intentions`, `lessons`). They exist so that a user can walk into any chat and say *"arbeite am Projekt X"* and the agent reliably picks up the right context. Before this layer, everything was pooled flat — semantically searchable, but with no handle a user could speak out loud to route focus.

Projects were introduced in **migration 045** (2026-04-20). They are opt-in on writes and transparent on reads: old data keeps working, new data can be scoped.

---

## Mental model

```
projects ──┐
           ├── memories      (nullable project_id)
           ├── experiences   (nullable project_id)
           ├── intentions    (nullable project_id)
           └── lessons       (nullable project_id)

agent_active_project
  (agent_genome_id → project_id)
```

- A **project** has a stable `slug` (kebab-case), a human-readable `name`, a `description`, and a `status` (`active` / `paused` / `completed` / `archived`).
- Cognitive rows may or may not carry a `project_id`. Rows with `project_id = NULL` are **global** — they belong to no project and are returned by any global recall.
- Each agent (identified by its genome label) can have one **active project** at a time. While set, writes from that agent auto-scope.

---

## User workflow

1. **Create a project** — via the dashboard's "projekte" tab (+ neues projekt), or via MCP `create_project`.
2. **Open it** — the dashboard card has a 📋 *prompt kopieren* button. Paste the generated prompt into a chat with an agent that has the vector-memory MCP wired up. The agent will:
   - call `project_brief("your-slug")` to load current state (open intentions, recent experiences, key memories, top lessons),
   - call `set_active_project("your-slug")` so subsequent writes are auto-scoped,
   - summarise what to work on next.
3. **Work normally** — every `remember` / `absorb` / `record_experience` / `set_intention` / `record_lesson` the agent makes during the session lands on the active project automatically.
4. **Switch or pause** — in the dashboard detail drawer, change status or use another project's copy-prompt. `clear_active_project` removes the scope so writes go back to global.

---

## MCP tools

All tools are registered on the same `vector-memory` MCP server.

| Tool | Purpose |
|---|---|
| `create_project(slug, name, description?, metadata?)` | Register a new project. |
| `list_projects(status?)` | List projects with activity counts. |
| `get_project(slug)` | Fetch header info only. |
| `project_brief(slug)` | **Single-call context priming**: header + counts + open intentions + recent experiences + key memories + top lessons. |
| `set_active_project(slug, agent?)` | Set the active project for an agent (default agent = `OPENCLAW_AGENT_LABEL`, typically `main`). |
| `update_project_status(slug, status)` | active / paused / completed / archived. |
| `link_to_project(table, row_id, slug)` | Retroactively attach or detach a single memory / experience / intention / lesson row. Pass `slug=null` to detach. |

### Auto-scoping on existing writers

These existing tools now accept an optional `project` parameter:

- `remember`, `absorb`
- `record_experience`, `set_intention`, `record_lesson`

Resolution order for the effective scope:

1. Explicit `project: "slug"` — use it (or `project: null` to force global).
2. Else: agent's active project (if set via `set_active_project`).
3. Else: `project_id = NULL` (global, backward-compatible).

Reads (`recall`, `list_memories`, etc.) stay global by default — project scoping on reads is explicit via `project_brief` or a `project` filter argument at the call site. This is intentional: "searching my memory" should not silently exclude things just because you happen to have an active project set.

---

## Dashboard

Tab **projekte**. Shows a grid of project cards, each with:

- name + slug + status badge (green/orange/blue/grey)
- short description
- activity counts (memories, experiences, open intentions, lessons)
- last activity timestamp
- **📋 prompt kopieren** — puts the ready-to-paste agent prompt in your clipboard
- **details** — expands an inline detail drawer with open intentions, recent experiences, key memories, top lessons, and an inline status switcher

Filter dropdown at the top: all / active / paused / completed / archived.

The dashboard writes go directly through the PostgREST proxy (`/api/projects` POST/PATCH). Reads call `list_projects_with_activity` and `project_brief` RPCs.

---

## Design decisions

**Why flat projects (no parent/child)?** 99% of user-spoken project references are flat. Parent/child adds UI and query complexity for a rare need. If hierarchy is ever required, a nullable `parent_project_id` migration is additive.

**Why not retroactively tag existing data?** The 500+ memories and 100+ experiences from before this migration are a mix of valuable history and experimental noise. Tagging them by heuristic would be magic; hand-tagging them is work the user didn't ask for. They stay `project_id = NULL` (global). The soft-forget mechanism handles decay naturally. Users can `link_to_project` selectively via the detail drawer.

**Why active-project influences only writes?** Because a user who says "was weißt du über X?" wants a full search, not a project-scoped one. Writes are where scope belongs — they're the point at which we know what context the information pertains to. Reads stay explicit.

**Why per-agent-label (not per-session)?** Sessions are transient and have no stable identifier across the MCP protocol. Agent labels (from `agent_genomes`) are persistent and already used everywhere else (neurochemistry, registry, federation). A user who switches chats but stays with the same agent keeps working on the same project until they explicitly switch. If someone wants true session-scoped projects later, that's additive (a column on sessions).

---

## Examples

**Create via MCP:**
```
create_project({
  slug: "vectormemory-schritt-3",
  name: "Vectormemory Schritt 3 — Tool-Discovery",
  description: "Dynamische Tool-Registrierung via Vektorsuche, damit smalle Modelle mit minimal-profile arbeiten können.",
})
```

**Typical agent entry:**
```
User: "Arbeite am Projekt `vectormemory-schritt-3`."
Agent: [calls project_brief("vectormemory-schritt-3")]
       [calls set_active_project("vectormemory-schritt-3")]
       "Stand: 3 offene Intentionen (…), letzte Experience vom 2026-04-20 …"
```

**Retro-link a single memory:**
```
link_to_project({
  table: "memories",
  row_id: "3d421505-…",
  slug: "vectormemory-schritt-3"
})
```

**Archive a done project:**
```
update_project_status({ slug: "vectormemory-schritt-3", status: "completed" })
```
