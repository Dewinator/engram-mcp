# Mycelium Middleware

A reverse-proxy that sits between an MCP client (or any Ollama caller) and the
local LLM endpoint. It deterministically injects mycelium's compact-context
block into the system prompt before forwarding, captures memory-worthy
statements after each turn, and fires a session digest when activity stops.

The middleware is mycelium's answer to the question: *how do small local
models get the same persistent identity, affect, and memory that Claude/Codex
get through the full MCP tool surface — without choking on 18k tokens of
schema?*

## Architecture

```
┌──────────────┐                     ┌────────────┐                ┌─────────┐
│  MCP client  │ ──── /api/chat ───► │  mycelium  │ ── /api/chat ─►│ Ollama  │
│  (qwen3:8b,  │                     │ middleware │                │ (local) │
│   gemma3:4b, │ ◄── reply + headers │   :18794   │ ◄── reply ──── │         │
│   anything)  │                     │            │                └─────────┘
└──────────────┘                     │            │
                                     │   ┌────────┴────────┐
                                     │   │ prime-fetcher   │── RPC ──► Supabase
                                     │   │ (cached, TTL 5m)│           pgvector
                                     │   ├─────────────────┤
                                     │   │ injector        │
                                     │   ├─────────────────┤
                                     │   │ post-processor  │── INSERT ► memories
                                     │   │   - auto-absorb │
                                     │   │   - auto-digest │── RPC ──► experiences
                                     │   └─────────────────┘
                                     └────────────┘
```

## What it does on every chat turn

1. **Prime fetch.** The proxy gets `prime_context_compact` data from Supabase
   (mood, traits, intentions, conflicts, top-N task experiences, top-N task
   memories, optional skill hints). Cached for 5 minutes per
   `(taskDescription, taskType)` key, so back-and-forth dialogue is cheap
   ([N7](../../issues/7)).

2. **Inject.** The compact block is prepended as a `system` message with
   sentinel markers `<!-- mycelium:context -->`. Idempotent on repeat
   forwards — the marker lets the middleware detect and replace its own
   block without doubling up. No markdown syntax in the block (small models
   parse `**bold**` and `#` as content; [N3](../../issues/3) flat
   bracketed format).

3. **Forward.** The full request (with injected system message) goes to
   Ollama's `/api/chat`. `stream:true` is rejected with HTTP 400 — Phase 1
   is non-streaming, SSE pass-through is Phase 1.5.

4. **Auto-Absorb.** The user message and assistant reply are both run
   through the conservative regex extractor ([N8](../../issues/8)). Any
   trigger-phrase hit (`ich habe gelernt:`, `merk dir:`, `wichtig:`,
   `@remember`, `note to self:`) is INSERTed as a `general` memory with
   provenance `source='middleware:auto-absorb'`. Best-effort, fired in the
   background — never delays the chat response.

5. **Session-tracking.** Per-client state (key = `${remoteAddress}|${userAgent}`)
   accumulates user/assistant message counts, models seen, error count.

6. **Auto-Digest.** A timer (60s default) sweeps for sessions idle ≥ 30min.
   Each non-silent idle session gets a `record_experience` RPC with the
   aggregated stats. Silent sessions (no user messages, no errors) are
   dropped without writing — per [N9 spec](./digest-trigger.md). The
   experience trigger then cascades through `compute_affect` → `agent_affect`
   → `neurochem_apply` (the [#11](../../issues/11) and [#56](../../pull/56)
   pipeline lights up automatically).

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `MYCELIUM_PROXY_PORT` | `18794` | TCP port the proxy listens on |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Upstream LLM endpoint |
| `SUPABASE_URL` | — (required) | mycelium Supabase root |
| `SUPABASE_KEY` | — (required) | Bearer + apikey for PostgREST |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embed model for prime + auto-absorb |
| `MYCELIUM_PROXY_RECALL_LIMIT` | `5` | Top-N experiences + memories injected |
| `MYCELIUM_PROXY_AUTO_ABSORB` | `1` | `0` to disable auto-absorb |
| `MYCELIUM_PROXY_AUTO_DIGEST` | `1` | `0` to disable auto-digest |
| `MYCELIUM_PROXY_IDLE_MS` | `1_800_000` (30min) | Session-idle threshold |
| `MYCELIUM_PROXY_DIGEST_TICK_MS` | `60_000` | Digester sweep interval |

## Running

### Easiest — via `install.sh` (registers a service)

```bash
curl -sSf https://raw.githubusercontent.com/Dewinator/mycelium/main/install.sh | bash
```

The installer brings up Docker + the dashboard, then registers a second
launchd / systemd-user unit (`com.mycelium.middleware` on macOS,
`mycelium-middleware.service` on Linux) that runs the proxy on port 18794
and restarts on crash. Pass `--no-middleware` to skip.

The unit reads its config from `docker/.env` automatically — the operator
only ever has to put `JWT_SECRET` there (which `setup.sh` already does for
the dashboard). The proxy mints its own service-role JWT on boot.

### Manual

The middleware reuses the MCP-server build artifact:

```bash
cd mycelium
npm --prefix mcp-server install
npm --prefix mcp-server run build

# All env vars are optional — proxy bootstraps from docker/.env
node mcp-server/dist/middleware/proxy.js
```

Override anything explicitly when needed:

```bash
SUPABASE_URL=http://localhost:54321 \
SUPABASE_KEY=<service-role-jwt> \
OLLAMA_URL=http://localhost:11434 \
node mcp-server/dist/middleware/proxy.js
```

Then point your MCP client (or any Ollama caller) at `http://127.0.0.1:18794`
instead of `http://127.0.0.1:11434`. The route shape is identical — the
proxy passes through every `/api/*` route Ollama exposes.

## Observability

### `/health`

Single endpoint for ops:

```json
{
  "status": "ok",
  "proxy_port": 18794,
  "targets": { "ollama": "http://127.0.0.1:11434", "supabase": "http://127.0.0.1:54321" },
  "upstreams": { "ollama": "ok", "supabase": "ok" },
  "cache": { "hits": 47, "misses": 12, "evictions": 0, "current_size": 12, "max_size": 200, "ttl_ms": 300000 },
  "auto_absorb": { "total_absorbed": 8, "total_skipped": 1, "total_failed": 0, "by_pattern": { ... } },
  "auto_digest": { "enabled": true, "sessions": 2, "total_fired": 4, "total_skipped_silent": 1, "ticks": 60 },
  "phase": 1
}
```

### Response headers

Every `/api/chat` response carries:

| Header | Values |
|---|---|
| `X-Mycelium-Injected` | `0 \| 1` — was a context block prepended? |
| `X-Mycelium-Injected-Bytes` | Length of the block (decimal) |
| `X-Mycelium-Cache` | `hit \| miss` — did the prime-fetch land in cache? |

Pipe `curl -i` and grep for these to inspect per-call behavior without
polling `/health`.

## Failure mode

The middleware is best-effort by design:

- **Supabase unreachable** → forward without injection (HTTP 200 anyway).
  `X-Mycelium-Injected: 0`.
- **Ollama unreachable** → return 502 to the client (the chat itself can't
  succeed without the upstream).
- **Auto-Absorb embed/insert fails** → log, increment failure counter, do
  nothing else. Chat response is unaffected.
- **Auto-Digest RPC fails** → log, roll back the in-flight lock, retry on
  next tick. Per [N9 §3](./digest-trigger.md) crash recovery is explicitly
  transient — no persisted intent table.

## Why not a single MCP server with per-session tool filtering?

See [#6 research comment](../../issues/6#issuecomment-4324856338). The two
choices are:

1. **Two MCP server instances** with different `MYCELIUM_TOOL_PROFILE` envs
   (zero new code, see [README §"Two profiles in parallel"](../README.md#two-profiles-in-parallel-recommended)).
2. **Reverse-proxy that injects context deterministically and lets a small
   model see almost no MCP tools at all** (this middleware).

Option 2 is the harder, longer-leverage answer: a 7-8B model doesn't have
to *decide* whether to call `prime_context` — the call is made for it, the
result is in the prompt, and the model just reads. Tool-use accuracy stops
mattering because there are no tools to use.

You can run both options side-by-side. Same Supabase backend, three
processes (full MCP server, core MCP server, middleware), zero conflict.

## Related

- [#1 — Small-Model Middleware Umbrella Epic](../../issues/1)
- [#2 — Reverse-Proxy skeleton](../../issues/2)
- [#3 — Context-Formatter](../../issues/3)
- [#4 — Auto-Absorb + Auto-Digest](../../issues/4)
- [#7 — Prime-Cache TTL+LRU](../../issues/7)
- [#8 — Conservative regex fact extractor](../../issues/8)
- [docs/digest-trigger.md](./digest-trigger.md) — N9 spec
- [docs/affect-observables.md](./affect-observables.md) — what compute_affect derives from the digest
