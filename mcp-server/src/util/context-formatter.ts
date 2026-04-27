/**
 * Compact context formatter for small-model consumers (issue #3, N3 of the
 * small-model-middleware epic).
 *
 * The default `prime_context` tool emits markdown that's pleasant in Claude
 * or Cursor but small local models (qwen2.5-7b, gemma3-4b) often parse the
 * `**bold**` and `#` headings as content rather than structure. This module
 * is a pure function that renders the same data as flat bracketed sections
 * with no markdown syntax — what issue #3 specifies.
 *
 * Pure: no I/O, no Date.now(), no randomness. Same input → same output. The
 * caller (e.g. a `prime_context_compact` MCP tool) is responsible for
 * gathering the data from Supabase.
 *
 * Token budget: hard ceiling ~1500 tokens. Estimated as ~4 chars/token, so
 * 6000 chars of post-render text. Per-section truncation keeps the bias
 * predictable (we never silently drop the affect block to make room for
 * recall hits — affect comes first, recall last).
 */

export interface AffectSnapshot {
  curiosity?:    number;
  frustration?:  number;
  satisfaction?: number;
  confidence?:   number;
  valence?:      number | null;
  arousal?:      number | null;
}

export interface MoodSnapshot {
  label?:        string;        // "pleased", "neutral", "frustrated", …
  valence?:      number;
  arousal?:      number;
  n?:            number;
  window_hours?: number;
}

export interface RecentPattern {
  last_n?:         number;
  success_rate?:   number | null;  // 0..1
  avg_difficulty?: number | null;  // 0..1
}

export interface TraitLine {
  trait:           string;
  polarity:        number;        // -1..1
  evidence_count?: number;
}

export interface IntentionLine {
  intention: string;
  priority?: number;              // 0..1
  progress?: number;              // 0..1
}

export interface ConflictLine {
  a_trait:        string;
  b_trait:        string;
  polarity_diff?: number;         // 0..2
}

export interface SkillLine {
  skill:        string;
  success_rate?: number | null;   // 0..1
  n_total?:     number;
  n_failure?:   number;
}

export interface RecallHit {
  content: string;
  outcome?: string | null;        // success, partial, failure, unknown
  kind?: string;                  // experience | lesson | memory | …
}

export interface CompactContextInput {
  task_description?: string;
  affect?:            AffectSnapshot;
  mood?:              MoodSnapshot;
  recent_pattern?:    RecentPattern;
  traits?:            TraitLine[];
  intentions?:        IntentionLine[];
  conflicts?:         ConflictLine[];
  skill_hints?:       { task_type: string; skills: SkillLine[] };
  task_experiences?:  RecallHit[];
  task_memories?:     RecallHit[];
  /** Optional final hint paragraph (e.g. a SOUL.md sentence). */
  soul_hint?:         string;
}

export interface CompactFormatOptions {
  /** Hard char ceiling. Default 6000 (~1500 tokens). */
  max_chars?: number;
  /** Max items per recall section. Default 5. */
  recall_per_section?: number;
  /** Max chars per recall hit (truncated with …). Default 160. */
  recall_truncate?: number;
  /** Max items per traits/intentions/conflicts section. Default 5. */
  list_per_section?: number;
}

const DEFAULTS: Required<CompactFormatOptions> = {
  max_chars:           6000,
  recall_per_section:  5,
  recall_truncate:     160,
  list_per_section:    5,
};

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return `${Math.round(n * 100)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function polaritySign(p: number): string {
  if (p > 0.1) return "+";
  if (p < -0.1) return "-";
  return "·";
}

/**
 * Render a CompactContextInput to a flat bracketed text block.
 *
 * Section order is fixed (so caching keys stay stable): state · mood ·
 * pattern · identity · aspirations · tensions · skills · task ·
 * facts · soul-hint. Empty sections are omitted entirely (no `[state]`
 * with nothing under it).
 *
 * The function is deterministic given the same input. It does NOT call
 * `new Date()` or any global state; the timestamp belongs to the caller.
 */
export function formatCompactContext(
  input: CompactContextInput,
  opts: CompactFormatOptions = {}
): string {
  const o = { ...DEFAULTS, ...opts };
  const lines: string[] = [];

  // [state] — agent_affect dimensions if any are present
  if (input.affect && hasAnyAffect(input.affect)) {
    lines.push("[state]");
    const a = input.affect;
    const parts: string[] = [];
    if (a.curiosity    != null) parts.push(`curiosity ${fmtNum(a.curiosity)}`);
    if (a.frustration  != null) parts.push(`frustration ${fmtNum(a.frustration)}`);
    if (a.satisfaction != null) parts.push(`satisfaction ${fmtNum(a.satisfaction)}`);
    if (a.confidence   != null) parts.push(`confidence ${fmtNum(a.confidence)}`);
    if (a.valence      != null) parts.push(`valence ${fmtNum(a.valence)}`);
    if (a.arousal      != null) parts.push(`arousal ${fmtNum(a.arousal)}`);
    lines.push("  " + parts.join("  "));
    lines.push("");
  }

  // [mood] — episodic mood from experiences (orthogonal to affect)
  if (input.mood && (input.mood.label || (input.mood.n ?? 0) > 0)) {
    const m = input.mood;
    const window = m.window_hours ? `${m.window_hours}h` : "recent";
    if ((m.n ?? 0) > 0) {
      lines.push("[mood]");
      lines.push(`  ${m.label ?? "neutral"} over ${window} (valence ${fmtNum(m.valence)}, arousal ${fmtNum(m.arousal)}, ${m.n} episodes)`);
    } else {
      lines.push("[mood]");
      lines.push(`  quiet — no episodes in last ${window}`);
    }
    lines.push("");
  }

  // [recent pattern] — success-rate one-liner
  if (input.recent_pattern && (input.recent_pattern.last_n ?? 0) > 0) {
    const p = input.recent_pattern;
    lines.push("[recent pattern]");
    lines.push(`  last ${p.last_n} tasks: ${fmtPct(p.success_rate)} success, avg difficulty ${fmtNum(p.avg_difficulty)}`);
    lines.push("");
  }

  // [identity] — soul traits
  if (input.traits && input.traits.length) {
    lines.push("[identity]");
    for (const t of input.traits.slice(0, o.list_per_section)) {
      const ev = t.evidence_count != null ? ` (ev ${t.evidence_count})` : "";
      lines.push(`  ${polaritySign(t.polarity)} ${truncate(t.trait, 140)}${ev}`);
    }
    lines.push("");
  }

  // [aspirations] — active intentions
  if (input.intentions && input.intentions.length) {
    lines.push("[aspirations]");
    for (const i of input.intentions.slice(0, o.list_per_section)) {
      const meta: string[] = [];
      if (i.priority != null) meta.push(`prio ${fmtNum(i.priority)}`);
      if (i.progress != null) meta.push(`${fmtPct(i.progress)} done`);
      const tail = meta.length ? `  (${meta.join(", ")})` : "";
      lines.push(`  - ${truncate(i.intention, 160)}${tail}`);
    }
    lines.push("");
  }

  // [tensions] — open conflicts
  if (input.conflicts && input.conflicts.length) {
    lines.push("[tensions]");
    for (const c of input.conflicts.slice(0, o.list_per_section)) {
      const gap = c.polarity_diff != null ? `  (gap ${fmtNum(c.polarity_diff)})` : "";
      lines.push(`  - "${truncate(c.a_trait, 80)}" vs "${truncate(c.b_trait, 80)}"${gap}`);
    }
    lines.push("");
  }

  // [skills] — skill recommendations for declared task_type
  if (input.skill_hints && input.skill_hints.skills.length) {
    lines.push(`[skills for ${input.skill_hints.task_type}]`);
    for (const s of input.skill_hints.skills.slice(0, o.list_per_section)) {
      const sr = fmtPct(s.success_rate);
      const tot = s.n_total != null ? ` over ${s.n_total}` : "";
      const fail = s.n_failure != null ? `, ${s.n_failure} fails` : "";
      lines.push(`  - ${s.skill}: ${sr} success${tot}${fail}`);
    }
    lines.push("");
  }

  // [task] — applicable past experiences
  if (input.task_experiences && input.task_experiences.length) {
    lines.push("[task experiences]");
    let i = 1;
    for (const e of input.task_experiences.slice(0, o.recall_per_section)) {
      const tag = e.kind === "lesson" ? "lesson" : (e.outcome ?? "exp");
      lines.push(`  ${i}. [${tag}] ${truncate(e.content, o.recall_truncate)}`);
      i += 1;
    }
    lines.push("");
  }

  // [facts] — applicable memories
  if (input.task_memories && input.task_memories.length) {
    lines.push("[facts]");
    let i = 1;
    for (const r of input.task_memories.slice(0, o.recall_per_section)) {
      lines.push(`  ${i}. ${truncate(r.content, o.recall_truncate)}`);
      i += 1;
    }
    lines.push("");
  }

  // [soul-hint] — single trailing sentence
  if (input.soul_hint && input.soul_hint.trim()) {
    lines.push("[soul-hint]");
    lines.push(`  ${truncate(input.soul_hint.trim(), 240)}`);
    lines.push("");
  }

  // Trim trailing blank line
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  let out = lines.join("\n");

  // Hard ceiling — last-resort guard. The per-section caps above keep us well
  // under 6000 chars in practice; this only fires on adversarial input.
  if (out.length > o.max_chars) {
    out = truncate(out, o.max_chars);
  }
  return out;
}

function hasAnyAffect(a: AffectSnapshot): boolean {
  return [a.curiosity, a.frustration, a.satisfaction, a.confidence, a.valence, a.arousal]
    .some((v) => v != null);
}

/** Rough token estimate (4 chars/token). Used by tests + budget assertions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
