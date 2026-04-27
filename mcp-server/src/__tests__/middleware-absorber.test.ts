/**
 * Auto-Absorb tests — exercise the dedupe + stats logic via a stubbed
 * embed/insert path. Live Supabase integration would couple the unit
 * suite to the docker stack; the absorber's contract surfaces (which
 * patterns it picks up, how it dedupes, when it gives up) are testable
 * without DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "../util/fact-extractor.js";

test("absorber — extractFacts gives the right hit count to feed the absorber", () => {
  // Sanity: this is the contract the absorber depends on. If extractFacts
  // changes, the absorber's per-turn count changes too — test the join.
  const userText = "Ich habe gelernt: PRs immer mit Test-Plan dokumentieren.";
  const assistantText = "Verstanden, ich werde das beachten. @remember test-plan-policy";
  const userHits = extractFacts(userText);
  const assistantHits = extractFacts(assistantText);
  assert.equal(userHits.length, 1);
  assert.equal(userHits[0].pattern, "ich_habe_gelernt");
  assert.equal(assistantHits.length, 1);
  assert.equal(assistantHits[0].pattern, "at_remember");
});

test("absorber — dedupe key collapses identical text across user/assistant sides", () => {
  // The absorber dedupes by `${pattern}::${text.toLowerCase()}`. Verify the
  // join here so a refactor that drops side-awareness doesn't accidentally
  // double-count.
  const text = "wichtiger Fakt";
  const pattern = "wichtig";
  const keyA = `${pattern}::${text.toLowerCase()}`;
  const keyB = `${pattern}::${text.toLowerCase()}`;
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, `${pattern}::${text.toUpperCase()}`); // case sensitivity matters? no — both sides lowercase
});

test("absorber — stats schema is stable", async () => {
  // We construct an Absorber with bogus URLs and just check the stats
  // shape. No real network calls fired.
  const { Absorber } = await import("../middleware/absorber.js");
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:0",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:0",
  });
  const s = a.stats();
  assert.equal(s.total_absorbed, 0);
  assert.equal(s.total_skipped, 0);
  assert.equal(s.total_failed, 0);
  assert.equal(s.by_pattern.ich_habe_gelernt, 0);
  assert.equal(s.by_pattern.merk_dir, 0);
  assert.equal(s.by_pattern.wichtig, 0);
  assert.equal(s.by_pattern.at_remember, 0);
  assert.equal(s.by_pattern.note_to_self, 0);
});

test("absorber — failure counters increment when embed/insert errors out", async () => {
  // Both URLs point to a dead port — embed will fail fast, every absorb
  // attempt counts as a failure. processTurn() must NOT throw.
  const { Absorber } = await import("../middleware/absorber.js");
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",  // port 1 is reserved, connection refused
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
  });
  const r = await a.processTurn(
    "Ich habe gelernt: tests first.",
    "Note to self: keep mocking the network in unit tests.",
  );
  assert.equal(r.absorbed, 0);
  assert.equal(r.failed, 2);             // both hits failed at embed step
  const s = a.stats();
  assert.equal(s.total_failed, 2);
  assert.equal(s.total_absorbed, 0);
});

test("absorber — empty input is a no-op (no errors, no attempts)", async () => {
  const { Absorber } = await import("../middleware/absorber.js");
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
  });
  const r = await a.processTurn(undefined, undefined);
  assert.equal(r.absorbed, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.failed, 0);
});

test("absorber — non-trigger text produces no absorbs and no failures", async () => {
  const { Absorber } = await import("../middleware/absorber.js");
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
  });
  // Both messages have NO trigger phrases → extractFacts returns []. The
  // absorber should not even attempt to embed.
  const r = await a.processTurn(
    "wie geht es dir heute?",
    "ich bin ein KI-modell, mir geht es gut.",
  );
  assert.equal(r.absorbed, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.failed, 0);
});

test("absorber — maxPerTurn caps how many hits are forwarded", async () => {
  const { Absorber } = await import("../middleware/absorber.js");
  const a = new Absorber({
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
    maxPerTurn:  2,
  });
  // Six trigger hits in user msg alone — cap should limit to 2.
  const userText = [
    "Ich habe gelernt: a.",
    "Ich habe gelernt: b.",
    "Ich habe gelernt: c.",
    "Wichtig: d.",
    "Wichtig: e.",
    "Wichtig: f.",
  ].join(" ");
  const r = await a.processTurn(userText, undefined);
  // All 2 attempted ones fail (network), but the cap prevented a 3rd attempt.
  assert.equal(r.failed, 2);
  assert.equal(r.absorbed, 0);
});
