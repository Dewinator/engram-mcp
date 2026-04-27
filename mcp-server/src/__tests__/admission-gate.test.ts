import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LESSON_MIN_CONFIDENCE,
  LESSON_MIN_SOURCES,
  TRAIT_MIN_EVIDENCE,
  clusterProjectScope,
  looksLikeAutoSummary,
  gateLessonAdmission,
  gateTraitAdmission,
} from "../services/admission-gate.js";

// ---------------------------------------------------------------------------
// clusterProjectScope — single source of truth for "all members agree on a
// single project_id". The lesson gate uses this to refuse cross-project
// clusters; mis-detecting consistency is exactly how vectorworks-scoped
// experiences leaked into mycelium-global identity traits in the first place.
// ---------------------------------------------------------------------------

test("clusterProjectScope: empty members → consistent, project_id null", () => {
  const out = clusterProjectScope([]);
  assert.equal(out.consistent, true);
  assert.equal(out.project_id, null);
});

test("clusterProjectScope: all same project_id → consistent", () => {
  const out = clusterProjectScope([
    { project_id: "p1" },
    { project_id: "p1" },
    { project_id: "p1" },
  ]);
  assert.equal(out.consistent, true);
  assert.equal(out.project_id, "p1");
});

test("clusterProjectScope: all NULL → consistent, project_id null", () => {
  const out = clusterProjectScope([
    { project_id: null },
    { project_id: null },
  ]);
  assert.equal(out.consistent, true);
  assert.equal(out.project_id, null);
});

test("clusterProjectScope: NULL + project → inconsistent (the leakage shape)", () => {
  // This is the exact shape that put vectorworks "Ich habe gelernt …" entries
  // into the mycelium-global self-model: a cluster mixing project-scoped and
  // global experiences. NULL must NOT be treated as a wildcard match.
  const out = clusterProjectScope([
    { project_id: "vectorworks" },
    { project_id: null },
  ]);
  assert.equal(out.consistent, false);
  assert.equal(out.project_id, null);
});

test("clusterProjectScope: two different projects → inconsistent", () => {
  const out = clusterProjectScope([
    { project_id: "p1" },
    { project_id: "p2" },
  ]);
  assert.equal(out.consistent, false);
});

// ---------------------------------------------------------------------------
// looksLikeAutoSummary — pattern detector for the "Ich habe gelernt …" /
// "I refreshed the context …" first-person episode recap that the issue
// body calls out as the four polluting entries currently in the mycelium
// self-model.
// ---------------------------------------------------------------------------

test("looksLikeAutoSummary: 'Ich habe gelernt …' → true", () => {
  assert.equal(
    looksLikeAutoSummary("Ich habe gelernt: Ich habe die Produktdaten-Tabelle geprüft."),
    true,
  );
});

test("looksLikeAutoSummary: 'I refreshed the context …' → true", () => {
  assert.equal(
    looksLikeAutoSummary("I refreshed the context for issue #11 and re-read the body."),
    true,
  );
});

test("looksLikeAutoSummary: 'I handled a heartbeat check …' → true", () => {
  assert.equal(
    looksLikeAutoSummary("I handled a heartbeat check at the end of the day."),
    true,
  );
});

test("looksLikeAutoSummary: a real rule passes (handlungsleitend)", () => {
  assert.equal(
    looksLikeAutoSummary("Wenn ein event-type Wire-Literal unpinned ist, dann konstant extrahieren."),
    false,
  );
});

test("looksLikeAutoSummary: empty / null → false", () => {
  assert.equal(looksLikeAutoSummary(""), false);
  assert.equal(looksLikeAutoSummary(null), false);
  assert.equal(looksLikeAutoSummary(undefined), false);
});

// ---------------------------------------------------------------------------
// gateLessonAdmission — three-way reject (low_confidence / too_few_sources /
// mixed_project_scope), defaults from the issue spec.
// ---------------------------------------------------------------------------

test("gateLessonAdmission: defaults match issue spec", () => {
  assert.equal(LESSON_MIN_CONFIDENCE, 0.7);
  assert.equal(LESSON_MIN_SOURCES, 3);
});

test("gateLessonAdmission: meets all thresholds → admit", () => {
  const out = gateLessonAdmission({ confidence: 0.8, member_count: 3, project_consistent: true });
  assert.equal(out.admit, true);
  assert.equal(out.reason, "ok");
});

test("gateLessonAdmission: confidence below 0.7 → reject low_confidence", () => {
  const out = gateLessonAdmission({ confidence: 0.65, member_count: 5, project_consistent: true });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "low_confidence");
});

test("gateLessonAdmission: confidence == 0.7 (boundary) → admit", () => {
  const out = gateLessonAdmission({ confidence: 0.7, member_count: 3, project_consistent: true });
  assert.equal(out.admit, true);
});

test("gateLessonAdmission: only 2 members → reject too_few_sources", () => {
  const out = gateLessonAdmission({ confidence: 0.9, member_count: 2, project_consistent: true });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "too_few_sources");
});

test("gateLessonAdmission: mixed project → reject mixed_project_scope", () => {
  const out = gateLessonAdmission({ confidence: 0.9, member_count: 4, project_consistent: false });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "mixed_project_scope");
});

test("gateLessonAdmission: opts can override thresholds (allow lower bar)", () => {
  const out = gateLessonAdmission(
    { confidence: 0.5, member_count: 2, project_consistent: true },
    { minConfidence: 0.4, minSources: 2 },
  );
  assert.equal(out.admit, true);
});

test("gateLessonAdmission: allowMixedProject opens the project gate", () => {
  const out = gateLessonAdmission(
    { confidence: 0.9, member_count: 4, project_consistent: false },
    { allowMixedProject: true },
  );
  assert.equal(out.admit, true);
});

test("gateLessonAdmission: reasons are checked in order — confidence wins over sources", () => {
  const out = gateLessonAdmission({ confidence: 0.5, member_count: 1, project_consistent: false });
  assert.equal(out.reason, "low_confidence");
});

test("gateLessonAdmission: reasons checked in order — sources wins over project", () => {
  const out = gateLessonAdmission({ confidence: 0.9, member_count: 1, project_consistent: false });
  assert.equal(out.reason, "too_few_sources");
});

// ---------------------------------------------------------------------------
// gateTraitAdmission — protects the self-model surface from auto-summaries
// and shallow-evidence promotions.
// ---------------------------------------------------------------------------

test("gateTraitAdmission: defaults match issue spec", () => {
  assert.equal(TRAIT_MIN_EVIDENCE, 3);
});

test("gateTraitAdmission: rule-form lesson with enough evidence → admit", () => {
  const out = gateTraitAdmission({
    lesson_text: "Wenn ein Wire-Literal unpinned ist, dann konstant extrahieren.",
    evidence_count: 4,
    project_id: "mycelium",
  });
  assert.equal(out.admit, true);
  assert.equal(out.reason, "ok");
});

test("gateTraitAdmission: 'Ich habe gelernt …' rejected as auto_summary", () => {
  // This is the exact pattern from the issue body — vectorworks Cameo-OPUS
  // recap that should never have been admitted as a global identity trait.
  const out = gateTraitAdmission({
    lesson_text: "Ich habe gelernt: Cameo OPUS H6 IP, 28 kg, 600 W LED.",
    evidence_count: 4,
    project_id: "vectorworks",
  });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "auto_summary");
});

test("gateTraitAdmission: evidence < 3 → reject low_evidence", () => {
  const out = gateTraitAdmission({
    lesson_text: "Wenn X, dann Y, weil Z.",
    evidence_count: 2,
    project_id: null,
  });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "low_evidence");
});

test("gateTraitAdmission: empty lesson_text → reject missing_text", () => {
  const out = gateTraitAdmission({ lesson_text: "", evidence_count: 5 });
  assert.equal(out.admit, false);
  assert.equal(out.reason, "missing_text");
});

test("gateTraitAdmission: low_evidence wins over auto_summary (order)", () => {
  // Both are violated; the cheaper numerical check is reported first so
  // telemetry counts the load-bearing reason.
  const out = gateTraitAdmission({
    lesson_text: "Ich habe gelernt: foo.",
    evidence_count: 1,
  });
  assert.equal(out.reason, "low_evidence");
});

test("gateTraitAdmission: minEvidence override", () => {
  const out = gateTraitAdmission(
    { lesson_text: "Wenn X, dann Y.", evidence_count: 2 },
    { minEvidence: 2 },
  );
  assert.equal(out.admit, true);
});
