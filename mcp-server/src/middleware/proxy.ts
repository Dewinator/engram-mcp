/**
 * Mycelium small-model middleware — Phase 1 reverse-proxy.
 * Issue #2 (N2 of the small-model-middleware epic).
 *
 * Architecture decisions (made unilaterally 2026-04-27, documentable in PR):
 *
 * - **Reverse-proxy, not openClaw plugin.** Per the issue body. Model-agnostic,
 *   testable against any LLM endpoint that speaks Ollama's `/api/chat` shape.
 * - **Phase 1: Ollama-only.** The local-model use case is the whole point of
 *   the small-model epic. Anthropic/OpenAI compatibility is Phase 2 — adds
 *   an extra adapter layer for `/v1/messages` / `/v1/chat/completions`.
 * - **Phase 1: stream:false enforced.** SSE streaming through an injection
 *   layer is non-trivial (the model emits before we'd see it) and would
 *   delay landing the keystone. Streaming lands as Phase 1.5.
 * - **Inject as a prepended system message** with a sentinel marker, not by
 *   mutating an existing system. Idempotent across repeat forwards. See
 *   inject.ts §strategy choices.
 * - **Best-effort prime fetch.** If Supabase / Ollama-embed is unreachable,
 *   we forward the request without injection rather than returning 5xx.
 * - **No auth in this layer.** Bearer tokens (if present) flow through
 *   transparently. mycelium runs on localhost; production deployment is
 *   out of scope for this skeleton.
 * - **Auto-Digest hook is a TODO marker, not active.** N4 wires the digest
 *   trigger; this proxy just leaves the hook-points labeled. Issue #4.
 *
 * Default config:
 *   MYCELIUM_PROXY_PORT  = 18794   (1879x family, next free after motivation)
 *   OLLAMA_URL           = http://127.0.0.1:11434
 *   SUPABASE_URL/KEY     = inherit from MCP server env
 */

import http from "node:http";
import { PrimeFetcher } from "./prime-fetcher.js";
import { injectContext, lastUserText, type ChatMessage } from "./inject.js";

interface OllamaChatRequest {
  model:    string;
  messages: ChatMessage[];
  stream?:  boolean;
  // pass-through fields we don't touch:
  options?: Record<string, unknown>;
  format?:  string | object;
  keep_alive?: string | number;
  tools?:   unknown[];
}

const PROXY_PORT      = Number(process.env.MYCELIUM_PROXY_PORT ?? 18794);
const OLLAMA_URL      = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY ?? process.env.SUPABASE_ANON_KEY;
const RECALL_LIMIT    = Number(process.env.MYCELIUM_PROXY_RECALL_LIMIT ?? 5);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[middleware] FATAL: SUPABASE_URL and SUPABASE_KEY must be set");
  process.exit(1);
}

const fetcher = new PrimeFetcher({
  supabaseUrl:    SUPABASE_URL,
  supabaseKey:    SUPABASE_KEY,
  ollamaUrl:      OLLAMA_URL,
  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  recallLimit:    RECALL_LIMIT,
});

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type":   "application/json; charset=utf-8",
    "Content-Length": String(buf.length),
    "Cache-Control":  "no-store",
  });
  res.end(buf);
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: OllamaChatRequest;
  try {
    parsed = JSON.parse(raw) as OllamaChatRequest;
  } catch (e) {
    return jsonResponse(res, 400, { error: "invalid_json", detail: String(e) });
  }
  if (!Array.isArray(parsed.messages)) {
    return jsonResponse(res, 400, { error: "messages must be an array" });
  }

  // Phase 1: enforce non-streaming. Streaming with mid-flight injection is
  // Phase 1.5 (SSE rewriter on top of fetch().body).
  if (parsed.stream === true) {
    return jsonResponse(res, 400, {
      error: "streaming_not_supported_yet",
      hint:  "set stream:false; SSE pass-through is Phase 1.5",
    });
  }
  parsed.stream = false;

  // Optional task_type via header (the chat protocol has no slot for it).
  const taskType = (req.headers["x-mycelium-task-type"] as string | undefined)?.trim() || undefined;

  const taskText = lastUserText(parsed.messages);
  const contextText = await fetcher.buildAndFormat(taskText, taskType);

  const injectedMessages = injectContext(parsed.messages, contextText);
  const upstreamBody = JSON.stringify({ ...parsed, messages: injectedMessages });

  // Forward to Ollama
  const upstreamUrl = new URL("/api/chat", OLLAMA_URL);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    upstreamBody,
    });
  } catch (e) {
    return jsonResponse(res, 502, {
      error:  "upstream_unreachable",
      target: String(upstreamUrl),
      detail: String(e),
    });
  }

  // TODO(N4): hook point for auto-digest — record session activity here so
  // the idle-timer can fire a record_experience downstream. Not active in
  // Phase 1.

  const ct = upstream.headers.get("content-type") ?? "application/json; charset=utf-8";
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "Content-Type":              ct,
    "Content-Length":            String(buf.length),
    "Cache-Control":             "no-store",
    "X-Mycelium-Injected":       contextText ? "1" : "0",
    "X-Mycelium-Injected-Bytes": contextText ? String(Buffer.byteLength(contextText, "utf8")) : "0",
  });
  res.end(buf);
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Health includes the upstream targets so an operator can curl one URL to
  // diagnose a wedge.
  const checks = await Promise.all([
    fetch(new URL("/api/version", OLLAMA_URL))
      .then((r) => ({ ollama: r.ok ? "ok" : `http_${r.status}` }))
      .catch((e) => ({ ollama: `unreachable: ${String(e)}` })),
    fetch(new URL("/", SUPABASE_URL!))
      .then((r) => ({ supabase: r.ok ? "ok" : `http_${r.status}` }))
      .catch((e) => ({ supabase: `unreachable: ${String(e)}` })),
  ]);
  jsonResponse(res, 200, {
    status: "ok",
    proxy_port: PROXY_PORT,
    targets: { ollama: OLLAMA_URL, supabase: SUPABASE_URL },
    upstreams: Object.assign({}, ...checks),
    phase: 1,
  });
}

const server = http.createServer((req, res) => {
  // Same routes Ollama exposes (so existing clients can swap host without
  // touching their request shape) — plus /health for ops.
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/api/chat") return void handleChat(req, res);
  if (req.method === "GET"  && url === "/health")   return void handleHealth(req, res);
  // Pass-through for any other Ollama route — e.g. /api/tags, /api/version,
  // /api/embed (mycelium itself uses /api/embed). No injection on those.
  if (url.startsWith("/api/")) {
    void passThrough(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

async function passThrough(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const upstreamUrl = new URL(req.url ?? "/", OLLAMA_URL);
  let upstream: Response;
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    delete headers.host;
    delete headers["content-length"];
    const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req);
    upstream = await fetch(upstreamUrl, { method: req.method ?? "GET", headers, body });
  } catch (e) {
    return jsonResponse(res, 502, { error: "upstream_unreachable", detail: String(e) });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(upstream.status, { "Content-Type": ct, "Content-Length": String(buf.length) });
  res.end(buf);
}

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.error(`mycelium middleware (Phase 1) listening on http://127.0.0.1:${PROXY_PORT}`);
  console.error(`  → forwards /api/chat to ${OLLAMA_URL}/api/chat with prime_context_compact injected`);
  console.error(`  → recall_limit=${RECALL_LIMIT}, supabase=${SUPABASE_URL}`);
  console.error(`  → health check: curl http://127.0.0.1:${PROXY_PORT}/health`);
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
