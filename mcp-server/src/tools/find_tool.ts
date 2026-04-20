import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

/**
 * find_tool — JIT tool discovery for small-model agents.
 *
 * Context: openClaw's full tool profile exposes ~75 tools. Loading their
 * descriptions into the agent's context (prompt prefill) costs 15–25k
 * tokens. On a 16k-context model like Qwen3 8B, that's already over the
 * limit before the user says anything. The minimal profile filters MCP
 * tools out entirely, so a minimal-agent can't reach them either.
 *
 * Resolution: we index each tool once as a memory with category='tool'
 * (see scripts/index-tools.mjs). The small agent runs with minimal profile
 * and calls find_tool(intent) whenever it needs a capability. find_tool
 * returns the top-k tool descriptions (name + purpose + how-to-invoke).
 * The agent then uses the returned tool via the usual mechanism.
 *
 * This is the core of "Schritt 3" — we trade a one-time prefill of the
 * entire tool registry for a semantic lookup per use, which scales
 * linearly with *used* tools instead of *existing* tools.
 */

export const findToolSchema = z.object({
  intent: z
    .string()
    .min(3)
    .describe(
      "Describe what you want to do in natural language. E.g. 'send an iMessage', 'schedule a cron job', 'read a file', 'search the web'. The server will match your intent against the indexed tool registry and return candidates."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe("How many top candidates to return. Default 3 — more noise, more coverage."),
});

export async function findTool(
  service: MemoryService,
  input: z.infer<typeof findToolSchema>
) {
  const results = await service.search(input.intent, "tool", input.limit, 0.65);

  if (results.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text:
          `No indexed tool matched '${input.intent}'. ` +
          `Either the tool registry is empty (run scripts/index-tools.mjs) or the intent phrasing is too different from the tool purposes. ` +
          `Try rephrasing in a more action-oriented way ('I want to X').`,
      }],
    };
  }

  // Render each candidate with its score + raw registry metadata so the
  // agent sees enough to pick confidently.
  const lines = results.map((r, i) => {
    const reg = (r.metadata as { registry?: { server?: string; tool?: string; purpose?: string } } | undefined)?.registry;
    const fullName = reg
      ? (reg.server === "functions" ? reg.tool : `${reg.server}.${reg.tool}`)
      : "(unknown)";
    const score = r.effective_score?.toFixed(3) ?? r.relevance?.toFixed(3) ?? "—";
    const purpose = reg?.purpose ?? r.content.split("\n")[2]?.replace(/^Zweck:\s*/, "") ?? "";
    return `${i + 1}. ${fullName}  (score=${score})\n   ${purpose}`;
  });

  const header = `Top ${results.length} tool${results.length === 1 ? "" : "s"} for '${input.intent}':`;
  return {
    content: [{
      type: "text" as const,
      text: `${header}\n\n${lines.join("\n\n")}\n\nInvoke the chosen one normally — it's registered with openClaw, even if your current profile didn't surface its schema upfront.`,
    }],
  };
}
