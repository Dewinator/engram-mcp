/**
 * Conservative regex-based fact extractor (issue #8, N8 of the
 * small-model-middleware epic).
 *
 * Goal: detect sentences that the user explicitly marked as
 * memory-worthy, without LLM in the loop. Auto-Absorb (N4) calls this
 * over each user message; matches become MCP `absorb` calls.
 *
 * Design constraint: very few, very safe patterns. Better to miss 10% of
 * memory-relevant statements than to flood the memory base with noise.
 * The acceptance criterion (#8) is precision ≥ 80% on a 20-snippet
 * benchmark — recall is explicitly secondary.
 *
 * Pure: no I/O, no globals, no Date.now(). Same input → same output.
 */

export type FactPattern =
  | "merk_dir"
  | "wichtig"
  | "at_remember"
  | "ich_habe_gelernt"
  | "note_to_self";

export interface FactHit {
  pattern:        FactPattern;
  /** The captured fact text — what should land in `absorb`. Trimmed, no trigger phrase. */
  text:           string;
  /** 0..1; pattern-level prior, not a learned probability. */
  confidence:     number;
  /** Char offset in the original input (start of the trigger phrase). */
  offset:         number;
}

interface PatternDef {
  id:        FactPattern;
  /** RegExp must have a single capture group around the fact text. Case-insensitive. */
  re:        RegExp;
  /** Pattern-level prior. Calibrated by the benchmark snippet set. */
  baseConf:  number;
}

/**
 * The five trigger patterns specified by issue #8.
 *
 * Common rules:
 * - Anchored at sentence start (^ inside an `m` flag) OR after `.!?` whitespace
 *   so we don't catch them mid-sentence ("die wichtige Frage ist…" should NOT
 *   match the `wichtig` trigger).
 * - The captured fact extends to the end of the line / next sentence break.
 * - DOTALL is intentionally OFF — facts are line-bounded; multi-line content
 *   would need a stronger trigger anyway.
 */
const PATTERNS: PatternDef[] = [
  {
    id: "ich_habe_gelernt",
    // "ich habe gelernt: …" or "ich habe gelernt, dass …"
    re: /(?:^|(?<=[.!?]\s))\s*ich\s+habe\s+gelernt[:,]\s*(?:dass\s+)?(.+?)(?:[.!?](?:\s|$)|$)/gim,
    baseConf: 0.9,
  },
  {
    id: "merk_dir",
    // "merk dir: …" / "merk dir, …" — sentence start only.
    // Excludes "merk dir das" without colon/comma to avoid imperatives that
    // continue past "dir" with arbitrary content.
    re: /(?:^|(?<=[.!?]\s))\s*merk\s+dir[:,]\s*(.+?)(?:[.!?](?:\s|$)|$)/gim,
    baseConf: 0.9,
  },
  {
    id: "wichtig",
    // "wichtig: …" — colon-delimited. Bare "wichtig," is too noisy
    // ("wichtig, dass du kommst" → conversational filler), so colon required.
    re: /(?:^|(?<=[.!?]\s))\s*wichtig:\s*(.+?)(?:[.!?](?:\s|$)|$)/gim,
    baseConf: 0.85,
  },
  {
    id: "at_remember",
    // "@remember …" — explicit annotation, very high signal.
    // Captures until end of line (no terminal punctuation needed because the
    // annotation itself is the marker — the user often writes it as a tag).
    re: /(?:^|\s)@remember\s+(.+?)(?:\n|$)/gim,
    baseConf: 0.95,
  },
  {
    id: "note_to_self",
    // "note to self: …" — English variant.
    re: /(?:^|(?<=[.!?]\s))\s*note\s+to\s+self[:,]\s*(.+?)(?:[.!?](?:\s|$)|$)/gim,
    baseConf: 0.9,
  },
];

/**
 * Extract memory-worthy fact statements from a user message.
 *
 * Returns hits in original order (offset-ascending). Multiple matches of the
 * same pattern in one message are all returned; deduplication is the
 * caller's job (Auto-Absorb collapses identical text).
 *
 * The captured text is trimmed but not otherwise normalised — the caller
 * should run absorb's existing classification/embedding over it.
 */
export function extractFacts(input: string): FactHit[] {
  if (!input || input.length === 0) return [];
  const hits: FactHit[] = [];
  for (const def of PATTERNS) {
    // Important: clone the RegExp per call so the lastIndex state from a
    // previous call doesn't leak. The module-level `re` carries `g` flag.
    const re = new RegExp(def.re.source, def.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const text = (m[1] ?? "").trim();
      if (text.length === 0) continue;
      hits.push({
        pattern:    def.id,
        text,
        confidence: def.baseConf,
        offset:     m.index,
      });
      // Guard against zero-length matches infinite-looping (unlikely with
      // these patterns but defensive).
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

/**
 * Convenience: just the captured text strings, in order. Useful for callers
 * that don't need pattern provenance — most of Auto-Absorb does.
 */
export function extractFactTexts(input: string): string[] {
  return extractFacts(input).map((h) => h.text);
}
