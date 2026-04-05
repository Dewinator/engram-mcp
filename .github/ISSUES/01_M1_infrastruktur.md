# M1: Infrastruktur — Supabase lokal aufsetzen

**Labels:** `milestone:M1`, `infrastructure`, `priority:high`

## Beschreibung

Lokales Supabase-Setup via Docker Compose mit minimaler Konfiguration (nur PostgreSQL + pgvector + PostgREST API). Kein vollständiges Supabase-Stack nötig — wir brauchen nur die Datenbank und die REST-API.

## Aufgaben

- [ ] `docker/docker-compose.yml` erstellen mit:
  - PostgreSQL 15+ mit pgvector Extension
  - PostgREST für REST-API Zugriff
  - Optional: Supabase Studio für DB-Verwaltung
- [ ] `docker/.env.example` mit allen nötigen Variablen (DB-Passwort, JWT Secret, API Keys)
- [ ] pgvector Extension aktivieren (`CREATE EXTENSION IF NOT EXISTS vector`)
- [ ] SQL-Migrationen erstellen:
  - `supabase/migrations/001_enable_pgvector.sql`
  - `supabase/migrations/002_create_memories_table.sql`
  - `supabase/migrations/003_create_search_functions.sql`
- [ ] `scripts/migrate.sh` — Migrationen automatisch ausführen
- [ ] `scripts/setup.sh` — Ersteinrichtung (Docker prüfen, .env erstellen, Container starten, migrieren)
- [ ] Health-Check: Script das prüft ob Supabase + pgvector bereit sind

## Datenbankschema

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] DEFAULT '{}',
  embedding VECTOR(768),
  metadata JSONB DEFAULT '{}',
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON memories USING gin (to_tsvector('german', content));
```

## Akzeptanzkriterien

- `docker compose up -d` startet PostgreSQL mit pgvector erfolgreich
- Alle Migrationen laufen fehlerfrei
- Health-Check Script bestätigt Betriebsbereitschaft
- `.env.example` enthält alle nötigen Variablen mit Kommentaren
