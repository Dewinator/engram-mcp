#!/usr/bin/env bash
# vectormemory-openclaw watchdog
# Ensures Docker, Supabase containers, and Ollama are running.
# Pulls the embedding model if missing. Logs to ~/Library/Logs/vectormemory-watchdog.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG="$HOME/Library/Logs/vectormemory-watchdog.log"

# Ensure Homebrew + standard paths are available under launchd
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

log "── watchdog tick ──"

# 1. Docker Desktop running?
if ! docker info >/dev/null 2>&1; then
  log "Docker not running, launching Docker Desktop…"
  open -a Docker || log "WARN: could not open Docker Desktop"
  # Wait up to 60s for Docker to come up
  for i in $(seq 1 30); do
    sleep 2
    if docker info >/dev/null 2>&1; then
      log "Docker is up"
      break
    fi
  done
fi

if ! docker info >/dev/null 2>&1; then
  log "ERROR: Docker still not reachable, aborting tick"
  exit 0
fi

# 2. Supabase containers up?
cd "$PROJECT_DIR/docker" || { log "ERROR: docker dir missing"; exit 0; }
RUNNING=$(docker compose ps --status running --services 2>/dev/null | wc -l | tr -d ' ')
EXPECTED=$(docker compose config --services 2>/dev/null | wc -l | tr -d ' ')
if [ "$RUNNING" -lt "$EXPECTED" ]; then
  log "Supabase: $RUNNING/$EXPECTED services running, starting…"
  docker compose up -d >> "$LOG" 2>&1
else
  log "Supabase: $RUNNING/$EXPECTED services running ✓"
fi

# 3. Ollama service running?
if ! curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "Ollama not reachable, starting via brew services…"
  brew services start ollama >> "$LOG" 2>&1 || log "WARN: brew services start ollama failed"
  for i in $(seq 1 15); do
    sleep 2
    if curl -s --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      log "Ollama is up"
      break
    fi
  done
fi

# 4. Embedding model present?
if curl -s --max-time 2 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -q "nomic-embed-text"; then
  log "Embedding model nomic-embed-text ✓"
else
  log "Pulling nomic-embed-text…"
  ollama pull nomic-embed-text >> "$LOG" 2>&1 || log "WARN: ollama pull failed"
fi

log "── tick done ──"
