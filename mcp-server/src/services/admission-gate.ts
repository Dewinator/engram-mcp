/**
 * admission-gate.ts — confidence + scope gate for lesson and trait promotion.
 *
 * Background (issue #80, reflection 2026-04-27): the REM synthesizer at
 * scripts/synthesize-cluster.mjs already returns
 *   { lesson, pattern_name, confidence, reinforce }
 * but the confidence is not actually used as an admission gate, so most
 * cluster work fails to become persistent generalisation. At the same time,
 * the self-model surfaces project-scoped "Ich habe gelernt …" auto-summaries
 * as global identity traits — cross-project leakage that the literature calls
 * behavioural / identity drift (arXiv 2604.12285 GAM, arXiv 2601.04170).
 *
 * This module is the single, pure choke point. No DB, no I/O. Caller assembles
 * the context ({ confidence, member_count, project_consistent } for lessons,
 * { lesson_text, evidence_count, project_id } for traits) and asks: should
 * this be admitted into the persistent layer?
 *
 * Defaults match the issue spec (τ_lesson = 0.7, N = 3, evidence ≥ 3) and are
 * overridable via opts so the nightly-sleep runner can tune via env vars
 * without re-publishing the helper.
 *
 * Verfassung: pure local computation; strengthens "Generalisierung-vor-
 * Sharing" by raising the bar before something can become a swarm-shareable
 * lesson, and shields per-node traits from cross-project content.
 */

export const LESSON_MIN_CONFIDENCE = 0.7;
export const LESSON_MIN_SOURCES    = 3;
export const TRAIT_MIN_EVIDENCE    = 3;

export interface ClusterMember {
  /** project_id from experiences row; null = unscoped (global) */
  project_id: string | null;
}

export interface ClusterProjectScope {
  /** True iff every member shares the same project_id (NULL counts as a value). */
  consistent: boolean;
  /** The shared project_id (or null when all members are unscoped); null when inconsistent. */
  project_id: string | null;
}

/**
 * Determine whether a cluster of experiences agrees on a single project scope.
 *
 * "Consistent" means every member has the same project_id, treating NULL as a
 * distinct value. A cluster mixing project A + global (NULL) is NOT consistent
 * — that is the exact pattern that lets vectorworks-scoped experiences leak
 * into global identity traits.
 */
export function clusterProjectScope(members: ClusterMember[]): ClusterProjectScope {
  if (!Array.isArray(members) || members.length === 0) {
    return { consistent: true, project_id: null };
  }
  const first = members[0].project_id ?? null;
  for (const m of members) {
    const pid = m.project_id ?? null;
    if (pid !== first) return { consistent: false, project_id: null };
  }
  return { consistent: true, project_id: first };
}

/**
 * Heuristic: does this lesson text look like a verbatim episode summary
 * rather than a generalised rule? The synthesizer's system prompt asks for
 * abstract handlungsleitende rules ("Wenn X dann Y, weil Z"); when the model
 * fails to abstract, it tends to fall back to a first-person past-tense
 * "Ich habe gelernt …" / "I refreshed the context …" recap of one episode.
 *
 * These are exactly the four entries currently polluting the mycelium
 * self-model. Reject them at the trait gate so the identity surface stays
 * generalisations-only.
 *
 * False positives: a legitimate rule that happens to start with "Ich habe
 * gelernt" is acceptable collateral — that opening is the issue's named
 * smell, and rephrasing in rule form is cheap.
 */
export function looksLikeAutoSummary(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const head = trimmed.slice(0, 80).toLowerCase();
  // German first-person episode recap (the specific pattern called out in
  // the issue body).
  if (head.startsWith("ich habe gelernt")) return true;
  // English equivalent — same shape, same problem.
  if (/^i (refreshed|handled|verified|checked|read|extended|added|extracted) /.test(head)) return true;
  // Generic "I did X and Y" past-tense recap with no rule structure.
  if (/^i (re-?read|reviewed|completed|finished) /.test(head)) return true;
  return false;
}

export interface LessonAdmissionInput {
  /** Synthesizer-reported confidence in the cluster's pattern (0..1). */
  confidence: number;
  /** Number of source experiences contributing to this cluster. */
  member_count: number;
  /** True iff all members share a single project scope (see clusterProjectScope). */
  project_consistent: boolean;
}

export interface AdmissionResult {
  admit: boolean;
  /** Stable machine-readable reason: "ok" on admit, otherwise a short tag. */
  reason: "ok"
        | "low_confidence"
        | "too_few_sources"
        | "mixed_project_scope"
        | "auto_summary"
        | "low_evidence"
        | "missing_text";
}

export interface LessonGateOpts {
  minConfidence?: number;
  minSources?: number;
  /** Override: when true, allow mixed-project clusters (default false). */
  allowMixedProject?: boolean;
}

/**
 * Gate the experience → lesson promotion path.
 *
 * Reject when:
 *   1. confidence < minConfidence  (default 0.7, per issue spec)
 *   2. member_count < minSources   (default 3)
 *   3. cluster crosses project scopes (unless allowMixedProject)
 *
 * Reasons are checked in that order; the first failure wins so telemetry
 * counters are unambiguous.
 */
export function gateLessonAdmission(
  input: LessonAdmissionInput,
  opts: LessonGateOpts = {},
): AdmissionResult {
  const minConfidence = opts.minConfidence ?? LESSON_MIN_CONFIDENCE;
  const minSources    = opts.minSources    ?? LESSON_MIN_SOURCES;

  if (!Number.isFinite(input.confidence) || input.confidence < minConfidence) {
    return { admit: false, reason: "low_confidence" };
  }
  if (!Number.isFinite(input.member_count) || input.member_count < minSources) {
    return { admit: false, reason: "too_few_sources" };
  }
  if (!opts.allowMixedProject && input.project_consistent === false) {
    return { admit: false, reason: "mixed_project_scope" };
  }
  return { admit: true, reason: "ok" };
}

export interface TraitAdmissionInput {
  /** The lesson text that would become the trait. */
  lesson_text: string | null | undefined;
  /** evidence_count from the lessons row. */
  evidence_count: number;
  /** project_id of the lesson row; null = unscoped (global). */
  project_id?: string | null;
}

export interface TraitGateOpts {
  minEvidence?: number;
}

/**
 * Gate the lesson → self-model trait promotion path.
 *
 * Reject when:
 *   1. lesson_text is empty (defensive — promote_lesson_to_trait would fail)
 *   2. evidence_count < minEvidence (default 3)
 *   3. lesson_text looks like a per-episode auto-summary
 *
 * Note: project-scope consistency for traits is enforced at the lesson layer
 * (a lesson that passed the lesson gate already has a single project_id).
 * We pass through project_id here only so callers can route the trait into
 * the matching scope; we do not gate on it.
 */
export function gateTraitAdmission(
  input: TraitAdmissionInput,
  opts: TraitGateOpts = {},
): AdmissionResult {
  const minEvidence = opts.minEvidence ?? TRAIT_MIN_EVIDENCE;
  const text = (input.lesson_text ?? "").trim();
  if (text.length === 0) return { admit: false, reason: "missing_text" };
  if (!Number.isFinite(input.evidence_count) || input.evidence_count < minEvidence) {
    return { admit: false, reason: "low_evidence" };
  }
  if (looksLikeAutoSummary(text)) return { admit: false, reason: "auto_summary" };
  return { admit: true, reason: "ok" };
}
