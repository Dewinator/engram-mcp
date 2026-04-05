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

## Features

- **Hybrid-Suche**: 70% Vektorähnlichkeit + 30% Volltextsuche (konfigurierbar)
- **Deduplizierung**: Automatische Erkennung semantisch ähnlicher Einträge (>92% Ähnlichkeit)
- **HNSW-Index**: Optimiert für schnelle Nearest-Neighbor-Suche
- **Kategorie-System**: people, projects, topics, decisions, general
- **Markdown-Import**: Bestehende openClaw-Memories migrieren mit Dry-Run-Modus
- **Lokal & kostenlos**: Ollama Embeddings, kein API-Kosten

## Voraussetzungen

- **macOS** (Apple Silicon empfohlen, M1+) oder Linux
- **Docker Desktop** — [docker.com](https://www.docker.com/products/docker-desktop/)
- **Node.js >= 20** — [nodejs.org](https://nodejs.org/)
- **Ollama** — `brew install ollama && ollama pull nomic-embed-text`
- **openClaw** — [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- **psql** — `brew install postgresql` (für Migrationen)

**Ressourcenbedarf:** ~1 GB RAM (Supabase ~500 MB, Ollama Embedding ~270 MB)

## Schnellstart

```bash
# 1. Repo klonen
git clone https://github.com/Dewinator/vectormemory-openclaw.git
cd vectormemory-openclaw

# 2. Alles automatisch einrichten
./scripts/setup.sh
# → Prüft Abhängigkeiten
# → Erstellt .env mit zufälligen Secrets
# → Startet Supabase via Docker
# → Führt alle Migrationen aus
# → Baut den MCP Server
# → Gibt die openClaw-Config aus

# 3. Config in openClaw einfügen (Pfad anpassen!)
# Füge den ausgegebenen JSON-Block in deine openClaw settings.json ein
```

### Bestehende Memories importieren

```bash
# Vorschau (dry run)
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory --dry-run

# Import starten
export SUPABASE_KEY=dein_jwt_secret
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory
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
