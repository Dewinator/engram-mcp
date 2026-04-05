# M4: Migration & Hybrid-Betrieb

**Labels:** `milestone:M4`, `migration`, `priority:medium`

## Beschreibung

Bestehende Markdown-basierte Tier-3-Memories in die Supabase-Vektordatenbank migrieren. Parallelbetrieb ermöglichen, sodass bei Supabase-Ausfall auf Markdown-Dateien zurückgegriffen werden kann.

## Aufgaben

### Import-Tool
- [ ] `scripts/import-memories.ts` — Bulk-Import Script:
  - Scannt `memory/people/`, `memory/projects/`, `memory/topics/`, `memory/decisions/`
  - Parsed Markdown-Dateien (Titel, Inhalt, Metadaten)
  - Generiert Embeddings für jeden Eintrag
  - Importiert in Supabase mit korrekter Kategorie und Tags
  - Fortschrittsanzeige und Fehlerbehandlung
- [ ] Batch-Processing: Embeddings in Batches generieren (Rate-Limiting beachten)
- [ ] Duplikat-Erkennung: Bereits importierte Dateien überspringen
- [ ] Dry-Run Modus: Vorschau ohne tatsächlichen Import

### Validierung
- [ ] Vergleichstest: Gleiche Suchanfragen gegen altes (sqlite-vec) und neues (pgvector) System
- [ ] Relevanz-Metriken: Top-K Ergebnisse vergleichen
- [ ] Performance-Benchmark: Antwortzeiten messen

### Hybrid-Betrieb (Fallback)
- [ ] MCP Server: Health-Check für Supabase-Verbindung
- [ ] Fallback-Logik: Bei Supabase-Ausfall auf lokale Markdown-Dateien zurückfallen
- [ ] Logging: Wann und warum Fallback aktiviert wird
- [ ] Sync-Mechanismus: Neue Einträge während Fallback nachträglich in Supabase schreiben

## Akzeptanzkriterien

- Alle bestehenden Markdown-Memories erfolgreich importiert
- Suchqualität mindestens gleichwertig zum alten System
- Fallback auf Markdown funktioniert bei Supabase-Ausfall
- Import-Script ist idempotent (mehrfache Ausführung sicher)
