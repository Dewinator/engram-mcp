import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContradictionDetectedContext } from "../agents/conscience-agent.js";

// ---------------------------------------------------------------------------
// buildContradictionDetectedContext — JSONB payload contract for the
// `contradiction_detected` (and sibling `conscience_warning`) memory_events
// emitted by ConscienceAgent.
//
// Why these tests matter: the `contradicts_id` key is load-bearing for
// `findResolutionMatch` in services/relations.ts, which pairs a
// `contradiction_detected` row with its eventual `contradiction_resolved`
// counterpart (same trace_id) when `supersede_memory` runs. That pairing
// closes the open-conflict loop counted by compute_affect()'s frustration
// term — see docs/affect-observables.md §frustration:
//
//   open_conflicts = count(memory_events WHERE event_type='contradiction_detected'
//                          AND created_at > now()-'48h'
//                          AND NOT EXISTS (…resolution event with same trace_id…))
//
// A silent rename of `contradicts_id` here would not break compilation
// (the payload is JSONB) and would not break relations.test.ts (which
// tests the matcher in isolation against synthetic rows). It would
// silently zero out the resolution pairing — frustration would then
// over-count open conflicts indefinitely until someone noticed the
// dashboard drift. These tests pin the wire contract instead.
// ---------------------------------------------------------------------------

const CONTRADICTS_ID = "11111111-1111-1111-1111-111111111111";

test("buildContradictionDetectedContext returns exactly the keys findResolutionMatch + downstream consumers read", () => {
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.82, "conflicts on policy");
  assert.deepEqual(Object.keys(ctx).sort(), ["confidence", "contradicts_id", "reason"]);
});

test("buildContradictionDetectedContext maps contradictsId arg → 'contradicts_id' key (snake_case, load-bearing)", () => {
  // The TS arg is camelCase; the JSONB key MUST be 'contradicts_id'
  // because `findResolutionMatch` reads `e.context?.contradicts_id`.
  // A rename to camelCase would silently break the resolution pairing.
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.7, "");
  assert.equal(ctx.contradicts_id, CONTRADICTS_ID);
  assert.equal((ctx as unknown as Record<string, unknown>).contradictsId, undefined);
});

test("buildContradictionDetectedContext passes confidence through unchanged", () => {
  // Confidence is exposed for human-readable conscience_warning UIs and
  // for any future weighting in the frustration formula. Pin the
  // passthrough so a future helper that auto-buckets it (e.g. low/med/high)
  // is a deliberate contract change.
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.6125, "x");
  assert.equal(ctx.confidence, 0.6125);
  assert.equal(typeof ctx.confidence, "number");
});

test("buildContradictionDetectedContext truncates reason at 500 chars", () => {
  // The conscience-agent gateway can return long verdicts; the JSONB column
  // should not balloon. Pin the 500-char cap so the bound moves only
  // deliberately (it's also the cap used by the chain_memories p_reason
  // call site, which now reuses payload.reason).
  const long = "a".repeat(750);
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.7, long);
  assert.equal(ctx.reason.length, 500);
  assert.equal(ctx.reason, "a".repeat(500));
});

test("buildContradictionDetectedContext keeps reason at exactly 500 chars unchanged (boundary)", () => {
  // The cap is non-strict at the boundary: 500 in → 500 out, no slicing
  // surprises. Guards against an off-by-one rewrite (e.g. slice(0, 499)).
  const exact = "b".repeat(500);
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.7, exact);
  assert.equal(ctx.reason.length, 500);
  assert.equal(ctx.reason, exact);
});

test("buildContradictionDetectedContext keeps an empty reason as empty string (not null/undefined)", () => {
  // ConscienceAgent passes `verdict.reason ?? ""` into the helper, so the
  // empty-string case is the realistic input when the gateway returns
  // no rationale. Pin that the JSONB writes a string, not a missing key —
  // downstream code can rely on `typeof ctx.reason === "string"`.
  const ctx = buildContradictionDetectedContext(CONTRADICTS_ID, 0.9, "");
  assert.equal(ctx.reason, "");
  assert.equal(typeof ctx.reason, "string");
});

test("buildContradictionDetectedContext is pure (no aliasing across calls)", () => {
  // Mirrors the buildRecalledContext purity guard. The downstream RPC
  // serializes the object so identity doesn't matter, but mutation across
  // calls would be a footgun if the helper grows.
  const a = buildContradictionDetectedContext(CONTRADICTS_ID, 0.7, "first");
  const b = buildContradictionDetectedContext(CONTRADICTS_ID, 0.8, "second");
  assert.notStrictEqual(a, b);
  assert.equal(a.reason, "first");
  assert.equal(b.reason, "second");
  assert.equal(a.confidence, 0.7);
  assert.equal(b.confidence, 0.8);
});
