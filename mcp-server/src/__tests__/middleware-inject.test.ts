import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextBlock,
  injectContext,
  lastUserText,
  MYCELIUM_BLOCK_MARKER,
} from "../middleware/inject.js";

test("buildContextBlock — wraps with sentinel markers", () => {
  const out = buildContextBlock("[state]\n  curiosity 0.5");
  assert.ok(out.includes(MYCELIUM_BLOCK_MARKER));
  assert.equal(out.split(MYCELIUM_BLOCK_MARKER).length, 3);  // open + close
});

test("injectContext — prepends a system message when input is empty", () => {
  const out = injectContext([], "[state]\n  curiosity 0.5");
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "system");
  assert.ok(out[0].content.includes("[state]"));
});

test("injectContext — preserves existing messages", () => {
  const input = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const out = injectContext(input, "ctx");
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "system");
  assert.equal(out[1].role, "user");
  assert.equal(out[2].role, "assistant");
});

test("injectContext — does NOT mutate input array", () => {
  const input = [{ role: "user", content: "hi" }];
  const before = JSON.stringify(input);
  injectContext(input, "ctx");
  const after  = JSON.stringify(input);
  assert.equal(before, after);
});

test("injectContext — null/empty context returns clone unchanged", () => {
  const input = [{ role: "user", content: "hi" }];
  for (const empty of [null, undefined, "", "   "]) {
    const out = injectContext(input, empty as string | null);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    assert.notEqual(out, input);  // cloned
  }
});

test("injectContext — idempotent: replaces existing mycelium block", () => {
  const first = injectContext(
    [{ role: "user", content: "hi" }],
    "first context",
  );
  assert.equal(first.length, 2);
  assert.ok(first[0].content.includes("first context"));

  const second = injectContext(first, "second context");
  // Should still be exactly 2 messages — old block replaced, not stacked.
  assert.equal(second.length, 2);
  assert.ok(second[0].content.includes("second context"));
  assert.ok(!second[0].content.includes("first context"));
});

test("injectContext — non-mycelium system message is preserved", () => {
  const input = [
    { role: "system", content: "You are a careful agent." },
    { role: "user",   content: "hi" },
  ];
  const out = injectContext(input, "ctx");
  // Mycelium block prepended; existing system stays as the SECOND message.
  assert.equal(out.length, 3);
  assert.ok(out[0].content.includes(MYCELIUM_BLOCK_MARKER));
  assert.equal(out[1].role, "system");
  assert.equal(out[1].content, "You are a careful agent.");
});

test("lastUserText — returns most recent user message", () => {
  const msgs = [
    { role: "user",      content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user",      content: "second" },
    { role: "assistant", content: "again" },
  ];
  assert.equal(lastUserText(msgs), "second");
});

test("lastUserText — undefined when no user message", () => {
  assert.equal(lastUserText([]), undefined);
  assert.equal(lastUserText([{ role: "system", content: "x" }]), undefined);
  assert.equal(lastUserText([{ role: "assistant", content: "x" }]), undefined);
});

test("lastUserText — skips empty user messages", () => {
  const msgs = [
    { role: "user", content: "real" },
    { role: "user", content: "   " },
  ];
  assert.equal(lastUserText(msgs), "real");
});
