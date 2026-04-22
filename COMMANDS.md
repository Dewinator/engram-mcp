# mycelium — Befehlsreferenz

## Installation

```bash
# Backup deiner openClaw-Config (ZUERST!)
cp ~/.openclaw/settings.json ~/.openclaw/settings.json.backup

# Repo klonen
git clone https://github.com/Dewinator/mycelium.git
cd mycelium

# One-Click Installer (oder Doppelklick auf install.command im Finder)
./install.command

# → Config wird in Zwischenablage kopiert
# → In openClaw settings.json einfügen (Cmd+V)
```

## Täglicher Betrieb

```bash
# Nach Mac-Neustart: Docker starten (Docker Desktop muss laufen)
cd ~/mycelium/docker && docker compose up -d

# Status prüfen
cd ~/mycelium && bash scripts/health-check.sh

# Logs ansehen
cd ~/mycelium/docker && docker compose logs -f
```

## Memory Import (optional)

```bash
# Vorschau (ändert nichts)
cd ~/mycelium
export SUPABASE_KEY=$(grep JWT_SECRET docker/.env | cut -d= -f2)
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory --dry-run

# Tatsächlicher Import
npx tsx scripts/import-memories.ts ~/.openclaw/workspace/memory
```

## Komplett rückgängig machen

```bash
# 1. openClaw-Config zurücksetzen
cp ~/.openclaw/settings.json.backup ~/.openclaw/settings.json

# 2. Docker stoppen + Daten löschen
cd ~/mycelium/docker && docker compose down -v

# 3. Projektordner löschen
rm -rf ~/mycelium
```
