import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { recordExperienceSchema } from "../tools/experience.js";
import { digestSchema } from "../tools/digest.js";

// ---------------------------------------------------------------------------
// experiences.outcome / experiences.user_sentiment enum contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md) reads
// these enum values as raw string literals in SQL:
//
//   §valence:        outcome IN ('success','partial','failure','unknown')
//   §satisfaction:   user_sentiment IN ('pleased','delighted')   ← positive
//                    user_sentiment IS NOT NULL                 ← all set
//
// The TypeScript Zod enums in record_experience and digest are the only
// places where these strings are produced before they hit the database.
// A silent rename here (e.g. "pleased" → "happy") would type-check, would
// pass every existing unit test, and would silently zero out the
// `pleased_ratio` term of the satisfaction formula and break the
// outcome_score branch of the valence formula. These tests pin the exact
// option set so any change forces an explicit, reviewable update of the
// SQL spec at the same time.
// ---------------------------------------------------------------------------

function enumOptions(schema: z.ZodTypeAny): readonly string[] {
  // The schemas chain modifiers: e.g. recordExperienceSchema.outcome is
  // z.enum([...]).optional().default("unknown") which yields
  // ZodDefault<ZodOptional<ZodEnum>>. Walk through ZodDefault / ZodOptional
  // wrappers until we hit the underlying ZodEnum.
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 4; i++) {
    if (current instanceof z.ZodEnum) return current.options as readonly string[];
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    break;
  }
  throw new Error("expected ZodEnum after unwrapping modifiers, got " + current.constructor.name);
}

// --- outcome ---------------------------------------------------------------

test("recordExperienceSchema.outcome enum is exactly the 4 values compute_affect §valence reads", () => {
  const opts = [...enumOptions(recordExperienceSchema.shape.outcome)].sort();
  assert.deepEqual(opts, ["failure", "partial", "success", "unknown"]);
});

test("digestSchema.outcome enum matches recordExperienceSchema.outcome (single source of truth)", () => {
  // Both code paths feed the same `experiences.outcome` column, so the
  // enums MUST be identical. A drift between the two would mean compute_affect
  // sees a value from one path but not the other.
  const a = [...enumOptions(recordExperienceSchema.shape.outcome)].sort();
  const b = [...enumOptions(digestSchema.shape.outcome)].sort();
  assert.deepEqual(a, b);
});

test("outcome enum contains every literal compute_affect §valence branches on", () => {
  // outcome_score()    +1.0 if 'success'
  //                    +0.2 if 'partial'
  //                    -1.0 if 'failure'
  //                     0.0 if 'unknown'
  // The test is the spec: dropping or renaming any of these breaks valence.
  const opts = new Set(enumOptions(recordExperienceSchema.shape.outcome));
  for (const required of ["success", "partial", "failure", "unknown"]) {
    assert.ok(opts.has(required), `outcome enum missing literal '${required}' required by compute_affect §valence`);
  }
});

// --- user_sentiment --------------------------------------------------------

test("recordExperienceSchema.user_sentiment enum is exactly the 5 values currently produced", () => {
  const opts = [...enumOptions(recordExperienceSchema.shape.user_sentiment)].sort();
  assert.deepEqual(opts, ["angry", "delighted", "frustrated", "neutral", "pleased"]);
});

test("digestSchema.user_sentiment enum matches recordExperienceSchema.user_sentiment", () => {
  // Same column (`experiences.user_sentiment`) must accept the same set
  // regardless of which tool wrote the row.
  const a = [...enumOptions(recordExperienceSchema.shape.user_sentiment)].sort();
  const b = [...enumOptions(digestSchema.shape.user_sentiment)].sort();
  assert.deepEqual(a, b);
});

test("user_sentiment enum contains the positive subset compute_affect §satisfaction reads", () => {
  // pleased_ratio numerator =
  //   count(experiences WHERE user_sentiment IN ('pleased','delighted') ...)
  // If either literal is renamed, the numerator silently goes to 0 and
  // satisfaction collapses to (0.6 * success_rate + 0.05) — a baseline
  // pinned just above neutral, which is the exact bug issue #11 fixes.
  const opts = new Set(enumOptions(recordExperienceSchema.shape.user_sentiment));
  assert.ok(opts.has("pleased"), "user_sentiment missing 'pleased' — breaks satisfaction.pleased_ratio numerator");
  assert.ok(opts.has("delighted"), "user_sentiment missing 'delighted' — breaks satisfaction.pleased_ratio numerator");
});

test("user_sentiment positive subset is a strict subset (denominator non-empty for non-positive sentiments)", () => {
  // The denominator counts ALL non-null sentiments, so we need at least one
  // value that isn't in the positive subset — otherwise pleased_ratio
  // collapses to a constant 1 and stops responding to negative feedback.
  const opts = new Set(enumOptions(recordExperienceSchema.shape.user_sentiment));
  const positive = new Set(["pleased", "delighted"]);
  const negative = [...opts].filter((v) => !positive.has(v));
  assert.ok(negative.length > 0, "user_sentiment has no non-positive values; pleased_ratio loses its discriminator");
});
