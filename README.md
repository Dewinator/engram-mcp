# vectormemory-openclaw

> Ersetzt das Markdown-basierte Tier-3-Gedächtnis von [openClaw](https://github.com/openclaw/openclaw) durch eine lokal gehostete **Supabase-Vektordatenbank** (PostgreSQL + pgvector).

## Warum?

openClaw nutzt standardmäßig ein dreistufiges Memory-System:
- **Tier 1** (`MEMORY.md`): Kuratierte Kernfakten, immer im Kontext
- **Tier 2** (`memory/YYYY-MM-DD.md`): Tägliche Notizen, automatisch geladen
- **Tier 3** (`memory/people/`, `memory/topics/`, ...): Tiefes Wissen, bei Bedarf durchsucht via sqlite-vec

**Das Problem:** Tier 3 mit sqlite-vec ist limitiert in Skalierbarkeit, Indexing-Optionen und Abfrageflexibilität. Eine dedizierte Vektordatenbank bietet bessere Performance, hybride Suche und professionelles Datenmanagement.

**Die Lösung:** Ein custom MCP Server verbindet openClaw mit einer lokal gehosteten Supabase-Instanz, die pgvector für semantische Vektorsuche und PostgreSQL-Volltextsuche kombiniert.

## Architektur

```
┌─────────────────────┐     MCP Protocol      ┌──────────────────────┐
│                     │ ◄──────────────────── │                      │
│   openClaw Agent    │                        │  Vector Memory MCP   │
│   (Claude/LLM)      │ ────────────────────► │  Server (TypeScript)  │
│                     │   remember / recall    │                      │
└─────────────────────┘                        └──────────┬───────────┘
                                                          │
                                               Supabase JS Client
                                                          │
                                               ┌──────────▼───────────┐
                                               │  Supabase (lokal)    │
                                               │  Docker Compose      │
                                               │  ┌────────────────┐  │
                                               │  │ PostgreSQL     │  │
                                               │  │ + pgvector     │  │
                                               │  └────────────────┘  │
                                               └──────────────────────┘
```

## Techstack

| Komponente | Technologie |
|---|---|
| Vektordatenbank | [Supabase](https://supabase.com) self-hosted + [pgvector](https://github.com/pgvector/pgvector) |
| Embeddings | [Ollama](https://ollama.com) (lokal, z.B. `nomic-embed-text`) oder OpenAI API |
| MCP Server | TypeScript + [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| Agent | [openClaw](https://github.com/openclaw/openclaw) |
| Container | Docker Compose |

## MCP Tools

| Tool | Beschreibung |
|---|---|
| `remember` | Neuen Memory-Eintrag mit Embedding speichern |
| `recall` | Semantische Hybrid-Suche (Vektor + Volltext) |
| `forget` | Memory-Eintrag löschen |
| `update_memory` | Bestehenden Eintrag aktualisieren |
| `list_memories` | Erinnerungen nach Kategorie auflisten |
| `import_markdown` | Bestehende Markdown-Memories importieren |

## Meilensteine

1. **Infrastruktur** — Supabase lokal via Docker + pgvector + DB-Schema
2. **MCP Server** — TypeScript MCP Server mit remember/recall/forget Tools
3. **openClaw Integration** — MCP Server in openClaw registrieren & konfigurieren
4. **Migration** — Bestehende Markdown-Memories nach Supabase importieren
5. **Optimierung** — Index-Tuning, Caching, Monitoring

## Schnellstart

```bash
# Voraussetzungen: Docker, Node.js >= 20, openClaw

# 1. Repo klonen
git clone https://github.com/Dewinator/vectormemory-openclaw.git
cd vectormemory-openclaw

# 2. Supabase starten
cp docker/.env.example docker/.env    # Secrets anpassen!
cd docker && docker compose up -d

# 3. Migrationen
bash scripts/migrate.sh

# 4. MCP Server
cd mcp-server && npm install && npm run build

# 5. In openClaw konfigurieren
# → Siehe openclaw-config/settings.example.json
```

## Projektstruktur

```
vectormemory-openclaw/
├── CLAUDE.md                    # Detaillierter Entwicklungsplan
├── README.md                    # Diese Datei
├── docker/                      # Supabase Docker Setup
│   ├── docker-compose.yml
│   └── .env.example
├── supabase/migrations/         # SQL-Migrationen
├── mcp-server/                  # MCP Server (TypeScript)
│   ├── src/tools/               # remember, recall, forget, ...
│   ├── src/services/            # Supabase Client, Embedding Pipeline
│   └── tests/
├── openclaw-config/             # openClaw Konfiguration
│   ├── TOOLS.md
│   └── settings.example.json
└── scripts/                     # Setup & Import Scripts
```

## Lizenz

MIT

## Mitwirken

Issues und Pull Requests sind willkommen. Details zum Entwicklungsworkflow in [CLAUDE.md](./CLAUDE.md).
