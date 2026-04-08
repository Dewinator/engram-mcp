import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreEncoding } from "../services/heuristics.js";

test("neutral text stays near defaults", () => {
  const s = scoreEncoding("der himmel ist blau");
  assert.equal(s.importance, 0.5);
  assert.equal(s.valence, 0);
  assert.equal(s.arousal, 0);
});

test("important keywords raise importance", () => {
  const s = scoreEncoding("Wichtig: Deadline ist am 2026-05-01");
  assert.ok(s.importance > 0.7, `expected >0.7, got ${s.importance}`);
});

test("positive keywords raise valence", () => {
  const s = scoreEncoding("ich liebe diesen ansatz, super gelungen");
  assert.ok(s.valence > 0.3);
});

test("negative + intense raises arousal and lowers valence", () => {
  const s = scoreEncoding("DRINGEND: kritischer bug, sofort fixen!!!");
  assert.ok(s.arousal > 0.5, `expected arousal>0.5, got ${s.arousal}`);
  assert.ok(s.importance > 0.6);
});

test("clamps stay in range", () => {
  const s = scoreEncoding("WICHTIG WICHTIG WICHTIG sofort dringend extrem!!! 2026-01-01 100€");
  assert.ok(s.importance <= 1);
  assert.ok(s.arousal <= 1);
  assert.ok(s.valence <= 1 && s.valence >= -1);
});
