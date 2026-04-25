import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRADICTION_DETECTED_EVENT_TYPE,
  CONTRADICTION_RESOLVED_EVENT_TYPE,
  MARK_USEFUL_EVENT_TYPE,
  RECALLED_EVENT_TYPE,
} from "../services/supabase.js";

// ---------------------------------------------------------------------------
// memory_events.event_type wire-literal contract — `contradiction_detected`
// and `contradiction_resolved`.
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §frustration) reads memory_events filtered by both literals to compute
// `open_conflicts`:
//
//   open_conflicts = count(memory_events
//                          WHERE event_type='contradiction_detected'
//                          AND created_at > now()-'48h'
//                          AND NOT EXISTS (…resolution event with same
//                                          trace_id…))
//
// The "…resolution event…" sub-clause matches
// `event_type='contradiction_resolved'` joined by trace_id. The two literals
// are co-load-bearing — a silent rename of *either* zeroes the
// `open_conflicts` term in different ways:
//
//   - rename `contradiction_detected` → frustration sees zero conflicts
//     (the outer count(*) collapses to 0).
//   - rename `contradiction_resolved` → frustration over-counts indefinitely
//     (no resolutions match, so every detection stays "open" forever).
//
// Each literal is emitted from a single producer:
//   - `contradiction_detected` — `agents/conscience-agent.ts`
//     (alongside `conscience_warning`, shared trace_id)
//   - `contradiction_resolved` — `services/relations.ts`
//     (`maybeEmitContradictionResolved` after a successful supersede_memory)
//
// `services/relations.ts` also reads `contradiction_detected` via
// `.eq("event_type", …)` to find the detection it should pair with the
// resolution — so producer + lookup share one constant. A silent rename
// would not break compilation, would not break the JSONB-payload guards in
// affect-event-payloads.test.ts (those test the context shape, not the
// event_type), would not surface in the FakeService accumulator in
// handlers.test.ts (which records function args, not the event_type), and
// would not be caught by relations.test.ts (which exercises
// `findResolutionMatch` over a hand-constructed row set, not the wire
// literal). Pinning the literals here makes a rename a single deliberate
// edit that fails this test until the spec doc + SQL are updated together —
// same defensive pattern as MARK_USEFUL_EVENT_TYPE (affect-event-types.test)
// and RECALLED_EVENT_TYPE (affect-recalled-event-type.test).
// ---------------------------------------------------------------------------

test("CONTRADICTION_DETECTED_EVENT_TYPE pins to the literal compute_affect §frustration reads", () => {
  // The SQL formula in docs/affect-observables.md §frustration filters
  // memory_events by exact-string equality
  // (`event_type='contradiction_detected'`). If this assertion fails, the
  // formula and the producer have drifted — update both together (constant
  // + spec doc + any SQL function) rather than weakening the test.
  assert.equal(CONTRADICTION_DETECTED_EVENT_TYPE, "contradiction_detected");
});

test("CONTRADICTION_RESOLVED_EVENT_TYPE pins to the literal compute_affect §frustration reads", () => {
  // The "NOT EXISTS (…resolution event…)" sub-clause matches
  // `event_type='contradiction_resolved'`. If this assertion fails, the
  // closer side of the open-conflict loop has drifted — frustration would
  // over-count indefinitely until the spec doc + producer are realigned.
  assert.equal(CONTRADICTION_RESOLVED_EVENT_TYPE, "contradiction_resolved");
});

test("CONTRADICTION_DETECTED_EVENT_TYPE is a string (not coerced to a non-string sentinel)", () => {
  // Defensive: log_memory_event takes p_event_type as TEXT, so anything but
  // a string would either throw at the RPC boundary or get serialised in a
  // surprising way. Pin the runtime type.
  assert.equal(typeof CONTRADICTION_DETECTED_EVENT_TYPE, "string");
});

test("CONTRADICTION_RESOLVED_EVENT_TYPE is a string (not coerced to a non-string sentinel)", () => {
  assert.equal(typeof CONTRADICTION_RESOLVED_EVENT_TYPE, "string");
});

test("CONTRADICTION_DETECTED_EVENT_TYPE is non-empty (would otherwise match every row)", () => {
  // A `""` event_type would silently break compute_affect()'s filter
  // (`event_type=''` matches nothing in practice but inserts would still
  // succeed against the TEXT column). Pin a length floor so an empty
  // string can't slip in via a bad refactor.
  assert.ok(CONTRADICTION_DETECTED_EVENT_TYPE.length > 0);
});

test("CONTRADICTION_RESOLVED_EVENT_TYPE is non-empty (would otherwise match every row)", () => {
  assert.ok(CONTRADICTION_RESOLVED_EVENT_TYPE.length > 0);
});

test("CONTRADICTION_DETECTED_EVENT_TYPE is snake_case (matches SQL convention used in the spec)", () => {
  // The spec doc, SQL functions, and the Postgres column convention all use
  // snake_case event_type strings. A camelCase or kebab-case rename would
  // silently miss the SQL filter. The regex is intentionally narrow — only
  // `[a-z0-9_]+` — to flag any drift toward another casing scheme.
  assert.match(CONTRADICTION_DETECTED_EVENT_TYPE, /^[a-z][a-z0-9_]*$/);
});

test("CONTRADICTION_RESOLVED_EVENT_TYPE is snake_case (matches SQL convention used in the spec)", () => {
  assert.match(CONTRADICTION_RESOLVED_EVENT_TYPE, /^[a-z][a-z0-9_]*$/);
});

test("CONTRADICTION_DETECTED_EVENT_TYPE is distinct from CONTRADICTION_RESOLVED_EVENT_TYPE (open vs closed)", () => {
  // The `open_conflicts` formula compares the two literals — the outer query
  // counts detections, the NOT EXISTS sub-query joins resolutions by
  // trace_id. A copy-paste edit that pointed both constants at the same
  // string would silently collapse the loop: every detection would
  // immediately match itself as "resolved" and `open_conflicts` would
  // permanently sit at zero. The dial would look healthy while the system
  // ignores actual contradictions.
  assert.notEqual(
    CONTRADICTION_DETECTED_EVENT_TYPE,
    CONTRADICTION_RESOLVED_EVENT_TYPE,
  );
});

test("contradiction event-type literals are distinct from the other compute_affect event types", () => {
  // The four pinned event-type literals — `mark_useful`, `recalled`,
  // `contradiction_detected`, `contradiction_resolved` — feed independent
  // formula terms in compute_affect (§satisfaction, §curiosity/§frustration,
  // §frustration). A copy-paste edit that aliased any pair would silently
  // collapse two independent dials into one perfectly-correlated signal.
  // Pin the full pairwise distinctness up front so a future "let's just
  // dedupe this constant" refactor fails loudly here.
  const all = new Set([
    MARK_USEFUL_EVENT_TYPE,
    RECALLED_EVENT_TYPE,
    CONTRADICTION_DETECTED_EVENT_TYPE,
    CONTRADICTION_RESOLVED_EVENT_TYPE,
  ]);
  assert.equal(all.size, 4);
});
