# CLAUDE.md — vectormemory-openclaw

## Projektziel

Dieses Projekt ersetzt das dateibasierte Gedächtnissystem von **openClaw** (Markdown-Dateien + sqlite-vec) durch eine **Supabase-Vektordatenbank** (PostgreSQL + pgvector), die lokal per Docker gehostet wird. Ziel ist ein skalierbares, semantisch durchsuchbares Langzeitgedächtnis für den openClaw-Agenten.

## Architektur-Übersicht

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
                                               │  │ + Embeddings   │  │
                                               │  └────────────────┘  │
                                               └──────────────────────┘
```

## Techstack

| Komponente | Technologie | Zweck |
|---|---|---|
| **Vektordatenbank** | Supabase (self-hosted Docker) + pgvector | Speicherung & Suche von Embeddings |
| **Embedding-Modell** | Lokales Modell via Ollama (z.B. `nomic-embed-text`) oder OpenAI `text-embedding-3-small` | Textumwandlung in Vektoren |
| **MCP Server** | Custom TypeScript MCP Server (`@modelcontextprotocol/sdk`) | Schnittstelle zwischen openClaw und Supabase |
| **openClaw Integration** | Plugin/Skill oder TOOLS.md-Konfiguration | Einbindung des MCP Servers in openClaw |
| **Sprache** | TypeScript (Node.js) | MCP Server, Migrations, Scripts |
| **Containerisierung** | Docker Compose | Lokales Supabase-Hosting |

## Memory-Architektur (Ziel)

### Bestehend (openClaw Standard)
- **Tier 1**: `MEMORY.md` — Kuratierte Kernfakten (~100 Zeilen), immer geladen
- **Tier 2**: `memory/YYYY-MM-DD.md` — Tägliche Notizen, automatisch geladen
- **Tier 3**: `memory/people/`, `memory/topics/`, etc. — Durchsucht via sqlite-vec + BM25

### Neu (dieses Projekt)
- **Tier 1 & 2**: Bleiben als Markdown (schneller Kontextzugriff, immer im Prompt)
- **Tier 3**: Migration auf Supabase pgvector mit Hybrid-Suche (Vektor + Volltext)
- **Zusätzlich**: Automatische Embedding-Generierung bei Speicherung neuer Erinnerungen

## Datenbankschema (pgvector)

```sql
-- Haupttabelle für Memory-Einträge
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',  -- people, projects, topics, decisions
  tags TEXT[] DEFAULT '{}',
  embedding VECTOR(768),                     -- Dimension abhängig vom Embedding-Modell
  metadata JSONB DEFAULT '{}',
  source TEXT,                               -- Ursprungsdatei oder Konversation
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW-Index für schnelle Vektorsuche
CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);

-- GIN-Index für Volltextsuche
CREATE INDEX ON memories USING gin (to_tsvector('german', content));

-- Hybrid-Suchfunktion
CREATE FUNCTION match_memories(
  query_embedding VECTOR(768),
  query_text TEXT,
  match_count INT DEFAULT 10,
  vector_weight FLOAT DEFAULT 0.7
) RETURNS TABLE (id UUID, content TEXT, category TEXT, similarity FLOAT)
AS $$ ... $$;
```

## MCP Server Tools

Der MCP Server stellt folgende Tools bereit:

| Tool | Beschreibung |
|---|---|
| `remember` | Speichert einen neuen Memory-Eintrag mit Embedding |
| `recall` | Semantische Suche über bestehende Erinnerungen |
| `forget` | Löscht einen Memory-Eintrag |
| `update_memory` | Aktualisiert einen bestehenden Eintrag |
| `list_memories` | Listet Erinnerungen nach Kategorie |
| `import_markdown` | Importiert bestehende Markdown-Memories in die Vektordatenbank |

## Meilensteine

### M1: Infrastruktur (Supabase lokal aufsetzen)
- [ ] Docker Compose für minimales Supabase-Setup (nur PostgreSQL + pgvector + API)
- [ ] `.env`-Konfiguration mit sicheren Secrets
- [ ] pgvector-Extension aktivieren
- [ ] Datenbankschema (Migrations) erstellen
- [ ] Health-Check Script

### M2: MCP Server Entwicklung
- [ ] TypeScript-Projekt mit `@modelcontextprotocol/sdk` initialisieren
- [ ] Supabase JS Client Integration
- [ ] Embedding-Pipeline (Ollama lokal oder OpenAI API)
- [ ] `remember`-Tool implementieren
- [ ] `recall`-Tool mit Hybrid-Suche implementieren
- [ ] `forget`- und `update_memory`-Tools
- [ ] `list_memories`-Tool
- [ ] Unit Tests

### M3: openClaw Integration
- [ ] MCP Server als openClaw-Tool registrieren (TOOLS.md / `.openclaw/settings.json`)
- [ ] SOUL.md / AGENTS.md anpassen für Memory-Nutzung
- [ ] Automatische Memory-Extraktion aus Konversationen
- [ ] Test: Ende-zu-Ende Workflow (Speichern → Suchen → Abrufen)

### M4: Migration & Hybrid-Betrieb
- [ ] `import_markdown`-Tool: Bestehende Tier-3-Markdown-Dateien in Supabase importieren
- [ ] Embedding-Generierung für importierte Dokumente
- [ ] Parallelbetrieb: Markdown-Fallback wenn Supabase nicht erreichbar
- [ ] Validierung: Suchqualität vergleichen (alt vs. neu)

### M5: Optimierung & Produktion
- [ ] HNSW-Index-Tuning (ef_construction, m Parameter)
- [ ] Embedding-Cache für häufige Abfragen
- [ ] Memory-Deduplizierung und -Konsolidierung
- [ ] Monitoring & Logging
- [ ] Dokumentation finalisieren

## Projektstruktur (Ziel)

```
vectormemory-openclaw/
├── CLAUDE.md                    # Diese Datei
├── README.md                    # Projektbeschreibung
├── docker/
│   ├── docker-compose.yml       # Supabase lokal
│   ├── .env.example             # Umgebungsvariablen Template
│   └── volumes/                 # Persistente Daten
├── supabase/
│   └── migrations/
│       ├── 001_enable_pgvector.sql
│       ├── 002_create_memories_table.sql
│       └── 003_create_search_functions.sql
├── mcp-server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts             # MCP Server Entrypoint
│   │   ├── tools/
│   │   │   ├── remember.ts
│   │   │   ├── recall.ts
│   │   │   ├── forget.ts
│   │   │   ├── update.ts
│   │   │   ├── list.ts
│   │   │   └── import.ts
│   │   ├── services/
│   │   │   ├── supabase.ts      # Supabase Client
│   │   │   └── embeddings.ts    # Embedding-Pipeline
│   │   └── types/
│   │       └── memory.ts
│   └── tests/
├── openclaw-config/
│   ├── TOOLS.md                 # Tool-Beschreibungen für openClaw
│   └── settings.example.json    # MCP Server Konfiguration
└── scripts/
    ├── setup.sh                 # Ersteinrichtung
    ├── migrate.sh               # DB-Migrationen ausführen
    └── import-memories.ts       # Markdown → Supabase Import
```

## Entwicklungsanweisungen

### Voraussetzungen
- Docker & Docker Compose
- Node.js >= 20
- openClaw installiert und konfiguriert
- Optional: Ollama für lokale Embeddings

### Setup
```bash
# 1. Supabase starten
cd docker && docker compose up -d

# 2. Migrationen ausführen
cd ../scripts && bash migrate.sh

# 3. MCP Server installieren & starten
cd ../mcp-server && npm install && npm run build

# 4. In openClaw konfigurieren (settings.json)
```

### Konventionen
- Commit-Messages auf Englisch, Präfix: `feat:`, `fix:`, `docs:`, `infra:`, `test:`
- TypeScript mit strict mode
- SQL-Migrationen nummeriert: `NNN_beschreibung.sql`
- Alle Secrets in `.env`, nie committen
- Tests vor jedem Merge erforderlich

### Wichtige Befehle
```bash
# MCP Server
cd mcp-server && npm run dev          # Entwicklung mit Hot-Reload
cd mcp-server && npm run build        # Produktions-Build
cd mcp-server && npm test             # Tests ausführen

# Supabase
cd docker && docker compose up -d     # Starten
cd docker && docker compose down      # Stoppen
cd docker && docker compose logs -f   # Logs verfolgen

# Migrationen
cd scripts && bash migrate.sh         # Alle Migrationen ausführen
```
