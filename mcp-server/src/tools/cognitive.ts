import { z } from "zod";
import type { MemoryService } from "../services/supabase.js";

// --- pin_memory ---------------------------------------------------------------
export const pinSchema = z.object({
  id: z.string().describe("Memory UUID"),
  pinned: z.boolean().default(true).describe("true = never forget, false = unpin"),
});

export async function pin(service: MemoryService, input: z.infer<typeof pinSchema>) {
  const m = await service.update({ id: input.id, pinned: input.pinned });
  return {
    content: [
      { type: "text" as const, text: `${input.pinned ? "Pinned" : "Unpinned"}: ${m.id}` },
    ],
  };
}

// --- introspect_memory --------------------------------------------------------
export const introspectSchema = z.object({
  id: z.string().describe("Memory UUID"),
});

export async function introspect(
  service: MemoryService,
  input: z.infer<typeof introspectSchema>
) {
  const m = await service.get(input.id);
  if (!m) {
    return { content: [{ type: "text" as const, text: `Not found: ${input.id}` }] };
  }
  const ageDays =
    (Date.now() - new Date(m.last_accessed_at ?? m.created_at).getTime()) / 86400000;
  const strengthNow =
    m.strength *
    Math.exp(-ageDays / (m.decay_tau_days * (1 + m.importance))) *
    (1 + Math.log1p(m.access_count));

  const text = [
    `id:           ${m.id}`,
    `content:      ${m.content}`,
    `category:     ${m.category}    stage: ${m.stage}    pinned: ${m.pinned}`,
    `tags:         ${m.tags.join(", ") || "(none)"}`,
    `created:      ${m.created_at}`,
    `last accessed:${m.last_accessed_at ?? "(never)"}`,
    `access_count: ${m.access_count}`,
    `importance:   ${m.importance}     valence: ${m.valence}    arousal: ${m.arousal}`,
    `strength:     ${m.strength.toFixed(3)} (base) -> ${strengthNow.toFixed(3)} (now, after ${ageDays.toFixed(1)}d)`,
    `decay_tau:    ${m.decay_tau_days} days`,
  ].join("\n");

  return { content: [{ type: "text" as const, text }] };
}

// --- consolidate_memories -----------------------------------------------------
export const consolidateSchema = z.object({
  min_access_count: z.number().int().min(1).optional().default(3),
  min_age_days: z.number().int().min(0).optional().default(1),
});

export async function consolidate(
  service: MemoryService,
  input: z.infer<typeof consolidateSchema>
) {
  const promoted = await service.consolidate(input.min_access_count, input.min_age_days);
  return {
    content: [
      {
        type: "text" as const,
        text: `Consolidated ${promoted} episodic memories into semantic stage.`,
      },
    ],
  };
}

// --- mark_useful --------------------------------------------------------------
export const markUsefulSchema = z.object({
  id: z.string().describe("Memory UUID that was actually used in an answer"),
});

export async function markUseful(
  service: MemoryService,
  input: z.infer<typeof markUsefulSchema>
) {
  await service.markUseful(input.id);
  return {
    content: [
      {
        type: "text" as const,
        text: `Marked useful: ${input.id} (strength bumped, useful_count++)`,
      },
    ],
  };
}

// --- dedup_memories -----------------------------------------------------------
export const dedupSchema = z.object({
  similarity_threshold: z.number().min(0).max(1).optional().default(0.93),
});

export async function dedup(
  service: MemoryService,
  input: z.infer<typeof dedupSchema>
) {
  const merged = await service.dedup(input.similarity_threshold);
  return {
    content: [
      {
        type: "text" as const,
        text: `Merged ${merged} near-duplicate memories into their representatives. Originals archived.`,
      },
    ],
  };
}

// --- forget_weak --------------------------------------------------------------
export const forgetWeakSchema = z.object({
  strength_threshold: z.number().min(0).optional().default(0.05),
  min_age_days: z.number().int().min(0).optional().default(7),
});

export async function forgetWeak(
  service: MemoryService,
  input: z.infer<typeof forgetWeakSchema>
) {
  const archived = await service.forgetWeak(input.strength_threshold, input.min_age_days);
  return {
    content: [
      {
        type: "text" as const,
        text: `Soft-forgot (archived) ${archived} weak memories. Originals preserved in forgotten_memories.`,
      },
    ],
  };
}
