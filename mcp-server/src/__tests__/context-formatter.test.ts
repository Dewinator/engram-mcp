import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCompactContext,
  estimateTokens,
  type CompactContextInput,
} from "../util/context-formatter.js";

test("formatter — empty input renders empty string", () => {
  const out = formatCompactContext({});
  assert.equal(out, "");
});

test("formatter — affect-only renders [state] section", () => {
  const out = formatCompactContext({
    affect: { curiosity: 0.72, frustration: 0.12, confidence: 0.54 },
  });
  assert.match(out, /^\[state\]/);
  assert.match(out, /curiosity 0\.72/);
  assert.match(out, /frustration 0\.12/);
  assert.match(out, /confidence 0\.54/);
  assert.doesNotMatch(out, /satisfaction/);  // not provided → not rendered
});

test("formatter — section order is fixed regardless of input key order", () => {
  const inputA: CompactContextInput = {
    soul_hint: "memory belongs to the user",
    affect: { curiosity: 0.5 },
    intentions: [{ intention: "ship N3" }],
    traits: [{ trait: "patient", polarity: 0.8 }],
  };
  const out = formatCompactContext(inputA);
  const stateIdx  = out.indexOf("[state]");
  const idIdx     = out.indexOf("[identity]");
  const aspIdx    = out.indexOf("[aspirations]");
  const soulIdx   = out.indexOf("[soul-hint]");
  assert.ok(stateIdx >= 0 && idIdx > stateIdx && aspIdx > idIdx && soulIdx > aspIdx,
    `section order broken: state=${stateIdx} id=${idIdx} asp=${aspIdx} soul=${soulIdx}`);
});

test("formatter — same input → same output (determinism)", () => {
  const input: CompactContextInput = {
    affect: { curiosity: 0.7, frustration: 0.2 },
    mood: { label: "pleased", valence: 0.5, arousal: 0.3, n: 12, window_hours: 24 },
    traits: [
      { trait: "Wenn ein wire-literal unpinned ist, dann konstant extrahieren", polarity: 0.9, evidence_count: 3 },
    ],
    intentions: [{ intention: "Montag 9:00 E-Mails checken", priority: 0.6, progress: 0.4 }],
    task_description: "ship the formatter",
    task_experiences: [{ content: "Last refactor went smoothly because tests came first.", outcome: "success" }],
  };
  const a = formatCompactContext(input);
  const b = formatCompactContext(input);
  assert.equal(a, b);
});

test("formatter — no markdown syntax in output", () => {
  const input: CompactContextInput = {
    affect: { curiosity: 0.5 },
    traits: [{ trait: "**bold trait** with markdown", polarity: 0.5 }],
    task_memories: [{ content: "# heading-like memory" }],
  };
  const out = formatCompactContext(input);
  // Section labels are bracketed, not markdown
  assert.doesNotMatch(out, /^#\s/m);          // no heading lines
  assert.doesNotMatch(out, /^\*\*[^*]+\*\*/m); // no bold lines (content with ** is fine)
  // Bracketed sections present
  assert.match(out, /^\[state\]$/m);
  assert.match(out, /^\[identity\]$/m);
});

test("formatter — recall truncation respects per-hit char limit", () => {
  const long = "x".repeat(500);
  const out = formatCompactContext({
    task_memories: [{ content: long }],
  }, { recall_truncate: 100 });
  // truncate keeps max-1 chars + "…"
  const facts = out.split("\n").filter(l => l.startsWith("  1. "));
  assert.equal(facts.length, 1);
  assert.ok(facts[0].length <= 5 + 100, `fact line too long: ${facts[0].length}`);
  assert.ok(facts[0].endsWith("…"));
});

test("formatter — recall_per_section caps the list length", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ content: `memory ${i}` }));
  const out = formatCompactContext({ task_memories: items }, { recall_per_section: 3 });
  const factLines = out.split("\n").filter(l => /^  \d+\. /.test(l));
  assert.equal(factLines.length, 3);
});

test("formatter — empty sections are omitted entirely", () => {
  const out = formatCompactContext({
    affect: { curiosity: 0.5 },
    traits: [],            // empty
    intentions: [],        // empty
    task_memories: [],     // empty
  });
  assert.match(out, /\[state\]/);
  assert.doesNotMatch(out, /\[identity\]/);
  assert.doesNotMatch(out, /\[aspirations\]/);
  assert.doesNotMatch(out, /\[facts\]/);
});

test("formatter — token budget respected even on adversarial input", () => {
  const huge = "a".repeat(50_000);
  const items = Array.from({ length: 50 }, () => ({ content: huge }));
  const out = formatCompactContext({
    affect: { curiosity: 0.5 },
    traits: items.slice(0, 50).map(c => ({ trait: c.content, polarity: 0.5 })),
    task_memories: items,
    task_experiences: items,
  });
  // hard ceiling 6000
  assert.ok(out.length <= 6000, `output ${out.length} chars exceeds 6000 ceiling`);
  // token budget 1500
  assert.ok(estimateTokens(out) <= 1500, `${estimateTokens(out)} tokens > 1500`);
});

test("formatter — issue #3 example shape", () => {
  // Mirror the example from the issue body. We're not asserting exact text,
  // but every documented landmark should be present.
  const out = formatCompactContext({
    affect: { curiosity: 0.72, frustration: 0.12, confidence: 0.54 },
    task_memories: [
      { content: "first memory hit" },
      { content: "second memory hit" },
    ],
    intentions: [
      { intention: "ich checke nächste Woche Montag um 9:00 Uhr meine E-Mails" },
    ],
    soul_hint: "ein Satz aus SOUL.md",
  });
  // landmarks
  assert.match(out, /\[state\]/);
  assert.match(out, /curiosity 0\.72/);
  assert.match(out, /\[facts\]/);          // "erinnerungen zum Topic" → [facts]
  assert.match(out, /\[aspirations\]/);    // "aktive Intentionen"     → [aspirations]
  assert.match(out, /\[soul-hint\]/);
  assert.match(out, /Montag um 9:00/);
});

test("formatter — polarity sign mapping", () => {
  const out = formatCompactContext({
    traits: [
      { trait: "patient",    polarity:  0.8 },
      { trait: "uncertain",  polarity:  0.05 },
      { trait: "frustrated", polarity: -0.7 },
    ],
  });
  assert.match(out, /  \+ patient/);
  assert.match(out, /  · uncertain/);
  assert.match(out, /  - frustrated/);
});
