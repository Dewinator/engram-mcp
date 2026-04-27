import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionTracker } from "../middleware/session-tracker.js";

test("tracker — buildKey strips ipv6-mapped prefix and trims user-agent", () => {
  const k1 = SessionTracker.buildKey("::ffff:127.0.0.1", "Claude/1.0");
  const k2 = SessionTracker.buildKey("127.0.0.1", "Claude/1.0");
  assert.equal(k1, k2);
});

test("tracker — touch creates session on first sight, increments counts", () => {
  const t = new SessionTracker();
  const s = t.touch({ client_key: "k", model: "qwen2.5:7b", user_present: true });
  assert.ok(s.session_id);
  assert.equal(s.user_messages, 1);
  assert.equal(s.assistant_messages, 0);
  assert.equal(s.errors, 0);
  assert.deepEqual([...s.models_seen], ["qwen2.5:7b"]);
});

test("tracker — repeat touches accumulate counts and unique models", () => {
  const t = new SessionTracker();
  t.touch({ client_key: "k", model: "qwen2.5:7b", user_present: true });
  t.touch({ client_key: "k", model: "qwen2.5:7b", upstream_ok: true });
  t.touch({ client_key: "k", model: "qwen2.5:3b", upstream_ok: false });
  const s = t.touch({ client_key: "k", model: "qwen2.5:3b", user_present: true });
  assert.equal(s.user_messages, 2);
  assert.equal(s.assistant_messages, 1);
  assert.equal(s.errors, 1);
  assert.deepEqual([...s.models_seen].sort(), ["qwen2.5:3b", "qwen2.5:7b"]);
});

test("tracker — reapIdle returns sessions past the threshold only", () => {
  let now = 1_000_000;
  const t = new SessionTracker({ idleMs: 1000, now: () => now });
  // session A is touched at t=0, then ages to 1500ms → idle
  t.touch({ client_key: "A", user_present: true });
  // session B is touched at t=1000, then ages 500ms → fresh (under threshold)
  now += 1000;
  t.touch({ client_key: "B", user_present: true });
  now += 500;
  const idle = t.reapIdle();
  assert.equal(idle.length, 1);
  assert.equal(idle[0].client_key, "A");
  assert.ok(idle[0].idle_ms >= 1000);
});

test("tracker — markDigestStart succeeds once, then blocks until finish/cancel", () => {
  const t = new SessionTracker();
  t.touch({ client_key: "k", user_present: true });
  assert.equal(t.markDigestStart("k"), true);
  assert.equal(t.markDigestStart("k"), false);  // advisory lock held
  t.cancelDigest("k");
  assert.equal(t.markDigestStart("k"), true);
  t.finishDigest("k");
  assert.equal(t.markDigestStart("k"), false);  // session removed
});

test("tracker — finishDigest removes session, next touch starts a new id", () => {
  const t = new SessionTracker();
  const s1 = t.touch({ client_key: "k", user_present: true });
  t.finishDigest("k");
  const s2 = t.touch({ client_key: "k", user_present: true });
  assert.notEqual(s1.session_id, s2.session_id);
});

test("tracker — reapIdle skips sessions already mid-digest", () => {
  let now = 1_000_000;
  const t = new SessionTracker({ idleMs: 1000, now: () => now });
  t.touch({ client_key: "k", user_present: true });
  now += 1500;
  assert.equal(t.markDigestStart("k"), true);
  // Now reapIdle should NOT see it again — would cause double-digest
  assert.equal(t.reapIdle().length, 0);
});

test("tracker — overflow eviction drops oldest by last_activity_at", () => {
  let now = 1_000_000;
  const t = new SessionTracker({ maxSessions: 2, now: () => now });
  t.touch({ client_key: "a" });
  now += 100;
  t.touch({ client_key: "b" });
  now += 100;
  t.touch({ client_key: "c" });            // overflow → "a" evicted
  assert.equal(t.size(), 2);
  const keys = t.snapshot().map((s) => s.client_key);
  assert.ok(keys.includes("b"));
  assert.ok(keys.includes("c"));
  assert.ok(!keys.includes("a"));
});

test("tracker — snapshot reports current idle_ms relative to clock", () => {
  let now = 1_000_000;
  const t = new SessionTracker({ now: () => now });
  t.touch({ client_key: "k", user_present: true });
  now += 5_000;
  const snap = t.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].idle_ms, 5_000);
});
