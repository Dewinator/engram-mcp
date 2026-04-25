import { test } from "node:test";
import assert from "node:assert/strict";
import { MARK_USEFUL_EVENT_TYPE } from "../services/supabase.js";

// ---------------------------------------------------------------------------
// memory_events.event_type wire-literal contract
//
// Why this guard exists: compute_affect() (docs/affect-observables.md
// §satisfaction) reads memory_events filtered by `event_type='mark_useful'`
// to compute `useful_delta`:
//
//   useful_delta = count(memory_events WHERE event_type='mark_useful'
//                        AND created_at > now()-'6h')
//                - count(memory_events WHERE event_type='mark_useful'
//                        AND created_at BETWEEN now()-'12h' AND now()-'6h')
//
// The string `mark_useful` is emitted from TWO independent producer call
// sites — one for memory subjects (MemoryService.emitMarkUseful in
// services/supabase.ts) and one for experience subjects
// (ExperienceService.markUseful in services/experiences.ts). A silent
// rename at one site (or both) would not break compilation, would not
// break any existing JSONB-payload guard (those test the context shape,
// not the event_type literal), and would not surface in the FakeService
// accumulator in handlers.test.ts. It would, however, zero out the
// satisfaction `useful_delta` term — and the symptom would look like
// "satisfaction stuck near baseline" instead of "events wrong type".
//
// Centralising the literal in `MARK_USEFUL_EVENT_TYPE` and pinning its
// value here makes a rename a single deliberate edit that also fails this
// test until the spec doc + SQL are updated to match. Same defensive
// pattern as the prior ticks for buildRecalledContext / outcomeToEventType
// / buildContradictionDetectedContext.
// ---------------------------------------------------------------------------

test("MARK_USEFUL_EVENT_TYPE pins to the literal compute_affect §satisfaction reads", () => {
  // The SQL formula in docs/affect-observables.md §satisfaction filters
  // memory_events by exact-string equality (`event_type='mark_useful'`).
  // If this assertion fails, the formula and the producer have drifted —
  // update both together (constant + spec doc + any SQL function) rather
  // than weakening the test.
  assert.equal(MARK_USEFUL_EVENT_TYPE, "mark_useful");
});

test("MARK_USEFUL_EVENT_TYPE is a string (not coerced to a non-string sentinel)", () => {
  // Defensive: a future maintainer might be tempted to swap the string for
  // a Symbol or numeric enum. log_memory_event takes p_event_type as TEXT,
  // so anything but a string would either throw at the RPC boundary or get
  // serialised in a surprising way. Pin the runtime type.
  assert.equal(typeof MARK_USEFUL_EVENT_TYPE, "string");
});

test("MARK_USEFUL_EVENT_TYPE is non-empty (would otherwise match every row)", () => {
  // A `""` event_type would silently break compute_affect()'s filter
  // (`event_type=''` matches nothing in practice but inserts would still
  // succeed against the TEXT column). Pin a length floor so an empty
  // string can't slip in via a bad refactor.
  assert.ok(MARK_USEFUL_EVENT_TYPE.length > 0);
});

test("MARK_USEFUL_EVENT_TYPE is snake_case (matches SQL convention used in the spec)", () => {
  // The spec doc, SQL functions, and the Postgres column convention all
  // use snake_case event_type strings. A camelCase or kebab-case rename
  // (e.g. "markUseful" / "mark-useful") would silently miss the SQL
  // filter. This regex is intentionally narrow — it only allows
  // `[a-z0-9_]+` — to flag any drift toward another casing scheme.
  assert.match(MARK_USEFUL_EVENT_TYPE, /^[a-z][a-z0-9_]*$/);
});
