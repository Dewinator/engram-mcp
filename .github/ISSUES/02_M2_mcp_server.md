# M2: MCP Server Entwicklung

**Labels:** `milestone:M2`, `feature`, `priority:high`

## Beschreibung

Entwicklung eines TypeScript MCP Servers, der als Schnittstelle zwischen openClaw und der Supabase-Vektordatenbank dient. Der Server implementiert das Model Context Protocol und stellt Tools für Speicherung, Suche und Verwaltung von Memory-Einträgen bereit.

## Aufgaben

### Projekt-Setup
- [ ] `mcp-server/package.json` mit Dependencies:
  - `@modelcontextprotocol/sdk` — MCP Server SDK
  - `@supabase/supabase-js` — Supabase Client
  - `ollama` oder `openai` — Embedding-Generierung
- [ ] `mcp-server/tsconfig.json` mit strict mode
- [ ] Build-Pipeline (TypeScript → JavaScript)

### Embedding-Pipeline (`src/services/embeddings.ts`)
- [ ] Abstraktes Interface für Embedding-Provider
- [ ] Ollama-Provider (lokal, `nomic-embed-text` oder `mxbai-embed-large`)
- [ ] OpenAI-Provider (Fallback, `text-embedding-3-small`)
- [ ] Konfigurierbar via Umgebungsvariablen

### Supabase Service (`src/services/supabase.ts`)
- [ ] Supabase Client Initialisierung
- [ ] CRUD-Operationen für Memory-Einträge
- [ ] Hybrid-Suchfunktion (Vektor + Volltext)

### MCP Tools
- [ ] `remember` — Speichert neuen Eintrag, generiert Embedding automatisch
  - Input: `content` (string), `category` (optional), `tags` (optional), `source` (optional)
  - Output: Bestätigung mit ID
- [ ] `recall` — Semantische Suche
  - Input: `query` (string), `category` (optional filter), `limit` (default 10)
  - Output: Relevante Erinnerungen mit Similarity-Score
- [ ] `forget` — Löscht Eintrag
  - Input: `id` (UUID)
- [ ] `update_memory` — Aktualisiert Inhalt + regeneriert Embedding
  - Input: `id` (UUID), `content` (string), `tags` (optional)
- [ ] `list_memories` — Auflistung nach Kategorie
  - Input: `category` (optional), `limit` (default 20)
- [ ] `import_markdown` — Bulk-Import von Markdown-Dateien
  - Input: `directory` (string) — Pfad zum Memory-Verzeichnis

### MCP Server Entrypoint (`src/index.ts`)
- [ ] Server-Konfiguration und Tool-Registrierung
- [ ] stdio Transport (Standard für MCP)
- [ ] Fehlerbehandlung und Logging

### Tests
- [ ] Unit Tests für Embedding-Service
- [ ] Unit Tests für Supabase-Service (mit Mocks)
- [ ] Integration Tests für MCP Tools
- [ ] E2E Test: remember → recall Workflow

## Akzeptanzkriterien

- MCP Server startet und registriert alle 6 Tools
- `remember` speichert Einträge mit korrektem Embedding
- `recall` liefert semantisch relevante Ergebnisse
- Alle Tests bestehen
- TypeScript kompiliert fehlerfrei im strict mode
