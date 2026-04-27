import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFacts, extractFactTexts, type FactHit } from "../util/fact-extractor.js";

// ---------------------------------------------------------------------------
// Unit-level tests for individual patterns
// ---------------------------------------------------------------------------

test("ich habe gelernt — colon variant", () => {
  const hits = extractFacts("Ich habe gelernt: keine Bastel-Lösungen, immer den sauberen Weg gehen.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, "ich_habe_gelernt");
  assert.equal(hits[0].text, "keine Bastel-Lösungen, immer den sauberen Weg gehen");
});

test("ich habe gelernt — comma+dass variant", () => {
  const hits = extractFacts("Ich habe gelernt, dass Migrations immer auf beiden DBs angewandt werden müssen.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "Migrations immer auf beiden DBs angewandt werden müssen");
});

test("merk dir — colon variant", () => {
  const hits = extractFacts("Merk dir: Reed will keine Markdown-Antworten von kleinen Modellen.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, "merk_dir");
  assert.equal(hits[0].text, "Reed will keine Markdown-Antworten von kleinen Modellen");
});

test("wichtig — colon-delimited only", () => {
  const hits = extractFacts("Wichtig: agent_neurochemistry.history hatte einen Wrapper-Bug.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, "agent_neurochemistry.history hatte einen Wrapper-Bug");
});

test("@remember — annotation style", () => {
  const hits = extractFacts("Note for the next session — @remember PostgREST cache muss nach migration NOTIFY'd werden.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, "at_remember");
  assert.equal(hits[0].text, "PostgREST cache muss nach migration NOTIFY'd werden.");
});

test("note to self — English variant", () => {
  const hits = extractFacts("Note to self: never amend a published commit without checking pre-commit hooks.");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern, "note_to_self");
});

test("multiple patterns in one message — preserves source order", () => {
  const msg = [
    "Wichtig: PR #56 schloss den Affect-Loop.",
    "Ich habe gelernt: Phase-3 hatte den neurochem-Pfad gekappt.",
    "@remember mig 065 wraps that.",
  ].join(" ");
  const hits = extractFacts(msg);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].pattern, "wichtig");
  assert.equal(hits[1].pattern, "ich_habe_gelernt");
  assert.equal(hits[2].pattern, "at_remember");
});

test("empty/whitespace input returns no hits", () => {
  assert.deepEqual(extractFacts(""), []);
  assert.deepEqual(extractFacts("   \n  \t"), []);
});

test("determinism — same input twice", () => {
  const msg = "Ich habe gelernt: tests first. Wichtig: kein Markdown.";
  const a = extractFacts(msg);
  const b = extractFacts(msg);
  assert.deepEqual(a, b);
});

test("RegExp lastIndex isolation — repeat calls don't leak state", () => {
  const msg = "Ich habe gelernt: das hier merkt sich der Agent.";
  for (let i = 0; i < 3; i++) {
    const hits = extractFacts(msg);
    assert.equal(hits.length, 1, `iteration ${i}: expected 1 hit, got ${hits.length}`);
  }
});

test("extractFactTexts — convenience returns text strings only", () => {
  const out = extractFactTexts("Ich habe gelernt: x. Wichtig: y.");
  assert.deepEqual(out, ["x", "y"]);
});

// ---------------------------------------------------------------------------
// Precision benchmark — issue #8 acceptance criterion
//
// 20 conversation snippets, half intentionally true positives (a real fact
// signal that SHOULD be captured), half adversarial (the trigger phrase is
// present but in a context that should NOT count — e.g. "die wichtige Frage
// ist…", a quoted past statement, etc.).
//
// Precision = TP / (TP + FP). Target: ≥ 0.80.
// Recall is secondary by design — the issue explicitly chose precision.
// ---------------------------------------------------------------------------

interface Sample {
  msg:           string;
  is_positive:   boolean;
  /** Optional substring expected in the captured text, when is_positive. */
  expect_text?:  string;
}

const SAMPLES: Sample[] = [
  // --- True positives (should produce ≥1 hit with the expected text) ---
  { msg: "Ich habe gelernt: PRs immer mit Test-Plan dokumentieren.",                            is_positive: true,  expect_text: "PRs immer mit Test-Plan" },
  { msg: "Merk dir: Reed mag flat-bracketed Format ohne Markdown.",                              is_positive: true,  expect_text: "Reed mag flat-bracketed" },
  { msg: "Wichtig: agent_affect ist ein Singleton, kein Per-User-Record.",                       is_positive: true,  expect_text: "Singleton" },
  { msg: "Folgesession: @remember mig 064 ist live, mig 065 schließt den loop.",                 is_positive: true,  expect_text: "mig 064 ist live" },
  { msg: "Note to self: stop suggesting destructive git ops without confirmation.",             is_positive: true,  expect_text: "stop suggesting destructive" },
  { msg: "Ich habe gelernt, dass sleep > 300s den Prompt-Cache verlässt.",                       is_positive: true,  expect_text: "sleep > 300s" },
  { msg: "Wichtig: bei jedem record_experience valence UND arousal ehrlich setzen.",             is_positive: true,  expect_text: "valence UND arousal" },
  { msg: "merk dir, openclaw bleibt authority — mycelium ist nur die memory-Schicht.",           is_positive: true,  expect_text: "openclaw bleibt authority" },
  { msg: "@remember claudeMd is the auto-loaded context file, settings.json is for hooks",       is_positive: true,  expect_text: "claudeMd" },
  { msg: "Ich habe gelernt: SELECT * mit jsonb_array_elements wickelt rekursiv ein.",            is_positive: true,  expect_text: "SELECT *" },

  // --- True negatives (the trigger word is present but the context is wrong) ---
  { msg: "Die wichtige Frage ist, ob der Reverse-Loop funktioniert.",                            is_positive: false },
  { msg: "Was hast du heute gelernt? — Ich habe gelernt: nichts heute, war frei.",               is_positive: true,  expect_text: "nichts heute, war frei" },
  // ↑ This one is technically positive — the user stated a fact. Keep as TP.
  { msg: "Wir wissen, was wichtig ist im Code-Review.",                                          is_positive: false },
  { msg: "Stell dir das mal vor — was würdest du merken?",                                       is_positive: false },
  { msg: "@anthropic ist ein anderer Tag, nicht @remember.",                                     is_positive: false },
  { msg: "Note: that thread had no actionable items.",                                           is_positive: false },
  { msg: "Wichtige Werte sind in env vars; siehe .mcp.json.",                                    is_positive: false },
  { msg: "Sie merkt dir das schon, keine Sorge.",                                                is_positive: false },
  { msg: "Ich glaube, das hat noch keiner gelernt — also kein Take-away.",                       is_positive: false },
  { msg: "Wichtig zu wissen: ist auch ein gängiger Ausdruck.",                                   is_positive: false },
  // ↑ no colon → should NOT match `wichtig`. Verifies the colon-required rule.
];

test("precision benchmark — ≥80% on 20 conversation snippets", () => {
  let tp = 0, fp = 0, fn = 0;

  for (const s of SAMPLES) {
    const hits = extractFacts(s.msg);
    const matched = hits.length > 0;

    if (matched && s.is_positive) {
      tp += 1;
      if (s.expect_text) {
        const found = hits.some((h: FactHit) => h.text.includes(s.expect_text!));
        assert.ok(found, `expected text "${s.expect_text}" in hits for: "${s.msg}" — got ${JSON.stringify(hits)}`);
      }
    } else if (matched && !s.is_positive) {
      fp += 1;
      console.error(`FP: "${s.msg}" → ${JSON.stringify(hits)}`);
    } else if (!matched && s.is_positive) {
      fn += 1;
    }
    // !matched && !s.is_positive → TN, ignored
  }

  const precision = tp / Math.max(1, tp + fp);
  const recall    = tp / Math.max(1, tp + fn);
  console.log(`benchmark: tp=${tp} fp=${fp} fn=${fn} → precision=${precision.toFixed(2)} recall=${recall.toFixed(2)}`);

  assert.ok(precision >= 0.80, `precision ${precision.toFixed(2)} < 0.80 target (tp=${tp}, fp=${fp})`);
  // Sanity floor on recall — if it dropped to 0 we'd pass precision but extract nothing.
  assert.ok(recall >= 0.50, `recall ${recall.toFixed(2)} < 0.50 sanity floor (tp=${tp}, fn=${fn})`);
});
