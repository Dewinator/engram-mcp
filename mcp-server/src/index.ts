#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEmbeddingProvider } from "./services/embeddings.js";
import { MemoryService } from "./services/supabase.js";
import { rememberSchema, remember } from "./tools/remember.js";
import { recallSchema, recall } from "./tools/recall.js";
import { forgetSchema, forget } from "./tools/forget.js";
import { updateSchema, update } from "./tools/update.js";
import { listSchema, list } from "./tools/list.js";
import { importSchema, importMarkdown } from "./tools/import.js";
import {
  pinSchema,
  pin,
  introspectSchema,
  introspect,
  consolidateSchema,
  consolidate,
  forgetWeakSchema,
  forgetWeak,
  markUsefulSchema,
  markUseful,
  dedupSchema,
  dedup,
} from "./tools/cognitive.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!SUPABASE_KEY) {
  console.error(
    "SUPABASE_KEY is required. Set it as an environment variable or in your MCP server config."
  );
  process.exit(1);
}

const embeddings = createEmbeddingProvider();
const memoryService = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);

const server = new McpServer({
  name: "vector-memory",
  version: "0.1.0",
});

/** Wrap tool handlers with error handling — returns MCP error response instead of crashing */
function withErrorHandling(
  fn: (input: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>
) {
  return async (input: Record<string, unknown>) => {
    try {
      return await fn(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Tool error:", message);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

server.tool(
  "remember",
  "Store a new memory with automatic embedding generation. Use for important facts, decisions, people info, or project details.",
  rememberSchema.shape,
  withErrorHandling((input) => remember(memoryService, rememberSchema.parse(input)))
);

server.tool(
  "recall",
  "Search memories using semantic similarity and keyword matching. Returns the most relevant memories for a query.",
  recallSchema.shape,
  withErrorHandling((input) => recall(memoryService, recallSchema.parse(input)))
);

server.tool(
  "forget",
  "Delete a specific memory by its UUID.",
  forgetSchema.shape,
  withErrorHandling((input) => forget(memoryService, forgetSchema.parse(input)))
);

server.tool(
  "update_memory",
  "Update an existing memory. If content changes, the embedding is automatically regenerated.",
  updateSchema.shape,
  withErrorHandling((input) => update(memoryService, updateSchema.parse(input)))
);

server.tool(
  "list_memories",
  "List stored memories, optionally filtered by category. Returns most recent first.",
  listSchema.shape,
  withErrorHandling((input) => list(memoryService, listSchema.parse(input)))
);

server.tool(
  "pin_memory",
  "Pin (or unpin) a memory so it is never soft-forgotten and gets a salience boost in recall.",
  pinSchema.shape,
  withErrorHandling((input) => pin(memoryService, pinSchema.parse(input)))
);

server.tool(
  "introspect_memory",
  "Inspect the cognitive state of a memory: strength, decay, access count, salience.",
  introspectSchema.shape,
  withErrorHandling((input) => introspect(memoryService, introspectSchema.parse(input)))
);

server.tool(
  "consolidate_memories",
  "Promote frequently-rehearsed episodic memories into the semantic stage (slower decay).",
  consolidateSchema.shape,
  withErrorHandling((input) => consolidate(memoryService, consolidateSchema.parse(input)))
);

server.tool(
  "mark_useful",
  "Signal that a recalled memory was actually used in an answer. Strongest learning signal — boosts strength substantially and increments useful_count.",
  markUsefulSchema.shape,
  withErrorHandling((input) => markUseful(memoryService, markUsefulSchema.parse(input)))
);

server.tool(
  "dedup_memories",
  "Cluster near-duplicate memories and merge them into the strongest representative. Co-activation links are transferred. Originals are archived.",
  dedupSchema.shape,
  withErrorHandling((input) => dedup(memoryService, dedupSchema.parse(input)))
);

server.tool(
  "forget_weak_memories",
  "Soft-forget memories whose effective strength has decayed below a threshold. Originals are archived, not deleted.",
  forgetWeakSchema.shape,
  withErrorHandling((input) => forgetWeak(memoryService, forgetWeakSchema.parse(input)))
);

server.tool(
  "import_markdown",
  "Import existing openClaw markdown memory files into the vector database. Supports dry_run mode.",
  importSchema.shape,
  withErrorHandling((input) => importMarkdown(memoryService, importSchema.parse(input)))
);

async function main() {
  // Verify Supabase is reachable before accepting connections
  const dbHealthy = await memoryService.healthCheck();
  if (!dbHealthy) {
    console.error(
      "WARNING: Supabase is not reachable at " + SUPABASE_URL +
      ". Memory operations will fail until the database is available."
    );
  }

  // Verify Ollama is reachable
  try {
    await embeddings.embed("health check");
    console.error("Ollama embedding provider: OK");
  } catch (err) {
    console.error(
      "WARNING: Ollama is not reachable. Embedding generation will fail. " +
      "Ensure Ollama is running: ollama serve"
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vector-memory MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
