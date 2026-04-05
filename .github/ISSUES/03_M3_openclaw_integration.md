# M3: openClaw Integration

**Labels:** `milestone:M3`, `integration`, `priority:medium`

## Beschreibung

Den MCP Server in openClaw einbinden, sodass der Agent die Vektordatenbank nahtlos als Gedächtnis nutzen kann. Dies umfasst die Konfiguration des MCP Servers als Tool, Anpassung der Workspace-Dateien und die Einrichtung automatischer Memory-Extraktion.

## Aufgaben

### MCP Server Registrierung
- [ ] `openclaw-config/settings.example.json` erstellen mit MCP Server Konfiguration:
  ```json
  {
    "mcpServers": {
      "vector-memory": {
        "command": "node",
        "args": ["path/to/mcp-server/dist/index.js"],
        "env": {
          "SUPABASE_URL": "http://localhost:54321",
          "SUPABASE_KEY": "...",
          "EMBEDDING_PROVIDER": "ollama"
        }
      }
    }
  }
  ```
- [ ] Dokumentation: Wie man den MCP Server in bestehende openClaw-Installation einbindet

### Workspace-Anpassung
- [ ] `openclaw-config/TOOLS.md` — Beschreibung der neuen Memory-Tools für den Agenten:
  - Wann `remember` nutzen (wichtige Fakten, Entscheidungen, Nutzerpräferenzen)
  - Wann `recall` nutzen (Kontext abrufen, frühere Entscheidungen nachschlagen)
  - Kategorien-Guide (people, projects, topics, decisions, general)
- [ ] Empfehlungen für SOUL.md-Anpassungen (Memory-Nutzung als Teil der Persönlichkeit)
- [ ] Empfehlungen für AGENTS.md-Anpassungen (Regeln für automatische Speicherung)

### Automatische Memory-Extraktion
- [ ] Strategie definieren: Welche Informationen automatisch gespeichert werden sollen
- [ ] HEARTBEAT.md-Beispiel: Periodische Memory-Konsolidierung
- [ ] Deduplizierung: Ähnliche Einträge erkennen und zusammenführen

### Testing
- [ ] E2E Test: openClaw-Session → remember → neue Session → recall
- [ ] Test: MCP Server Timeout/Fehler wird vom Agenten graceful behandelt
- [ ] Test: Kategorie-basierte Suche funktioniert korrekt

## Akzeptanzkriterien

- openClaw erkennt und nutzt den MCP Server als Tool
- Agent kann `remember` und `recall` in natürlicher Konversation aufrufen
- TOOLS.md gibt dem Agenten klare Anweisungen zur Memory-Nutzung
- Fehler im MCP Server crashen openClaw nicht
