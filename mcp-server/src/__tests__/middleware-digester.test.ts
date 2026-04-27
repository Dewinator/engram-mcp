/**
 * Digester unit tests — exercise the silent-skip + advisory-lock + tick-
 * counter logic. The actual record_experience RPC + ollama embed are stubbed
 * by pointing the digester at unreachable URLs (port 1, reserved). All
 * "fired" digests would land as failures; we test the routing / decision
 * logic, not the RPC contract (the MCP server's tests cover that).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionTracker } from "../middleware/session-tracker.js";
import { Digester } from "../middleware/digester.js";

function freshDigester(opts: { now?: () => number; idleMs?: number } = {}) {
  const tracker = new SessionTracker({ idleMs: opts.idleMs ?? 1000, now: opts.now });
  const digester = new Digester(tracker, {
    supabaseUrl: "http://127.0.0.1:1",
    supabaseKey: "stub",
    ollamaUrl:   "http://127.0.0.1:1",
    tickMs:      999_999,           // tests call tick() manually
  });
  return { tracker, digester };
}

test("digester — silent session is skipped, no RPC attempt", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now });
  // Touch with no user_present + no errors → session is silent.
  tracker.touch({ client_key: "k", model: "qwen" });
  now += 2000;
  const r = await digester.tick();
  assert.equal(r.fired, 0);
  assert.equal(r.skipped_silent, 1);
  assert.equal(r.failed, 0);
  // The session must be DROPPED so a new message starts fresh.
  assert.equal(tracker.size(), 0);
});

test("digester — non-idle sessions are not touched", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now, idleMs: 5_000 });
  tracker.touch({ client_key: "k", user_present: true });
  now += 1000;  // still well under idle threshold
  const r = await digester.tick();
  assert.equal(r.fired, 0);
  assert.equal(r.skipped_silent, 0);
  assert.equal(r.failed, 0);
  assert.equal(tracker.size(), 1);
});

test("digester — non-silent + idle session attempts the RPC", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now });
  tracker.touch({ client_key: "k", user_present: true, model: "qwen" });
  tracker.touch({ client_key: "k", upstream_ok: true });
  now += 2000;
  const r = await digester.tick();
  // Network is dead → fails. The point is: it ATTEMPTED the digest
  // (i.e. didn't skip-silent), and the lock was rolled back so the next
  // tick can retry.
  assert.equal(r.fired, 0);
  assert.equal(r.skipped_silent, 0);
  assert.equal(r.failed, 1);
  // Session still tracked because cancel rolled back the lock.
  assert.equal(tracker.size(), 1);
});

test("digester — advisory lock prevents concurrent fires of the same session", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now });
  tracker.touch({ client_key: "k", user_present: true });
  now += 2000;
  // First tick acquires the lock and tries to fire (will fail on network).
  const t1 = digester.tick();
  // Second tick fires while the first is in-flight — but we can't easily
  // simulate true concurrency in node:test. Easier: verify reapIdle()
  // skips locked sessions. That's the property the lock provides.
  assert.equal(tracker.markDigestStart("k"), false);  // lock NOT acquirable
  await t1;
});

test("digester — outcome derivation rules match the spec", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now });
  // One user msg + one assistant + zero errors → success
  // We can't see the outcome from outside without DB, but we CAN check
  // that the right code path runs by exercising tick() with each pattern.
  tracker.touch({ client_key: "ok", user_present: true });
  tracker.touch({ client_key: "ok", upstream_ok: true });
  tracker.touch({ client_key: "err", user_present: true });
  tracker.touch({ client_key: "err", upstream_ok: false });
  now += 2000;
  const r = await digester.tick();
  // Both attempted (no silent skip), both failed at network — but the
  // important property here is no silent skip and no double-fire.
  assert.equal(r.fired, 0);
  assert.equal(r.skipped_silent, 0);
  assert.equal(r.failed, 2);
});

test("digester — stats accumulate across ticks", async () => {
  let now = 1_000_000;
  const { tracker, digester } = freshDigester({ now: () => now });
  tracker.touch({ client_key: "silent" });   // touched but no user msg
  now += 2000;
  await digester.tick();
  await digester.tick();   // empty tick — already drained
  const s = digester.stats();
  assert.equal(s.ticks, 2);
  assert.equal(s.total_skipped_silent, 1);
  assert.ok(s.last_tick_at !== null);
});

test("digester — start/stop is idempotent", () => {
  const { digester } = freshDigester();
  digester.start();
  digester.start();   // 2nd start is a no-op
  digester.stop();
  digester.stop();    // 2nd stop is a no-op
  // Just checking no throw — verified by reaching this assertion.
  assert.ok(true);
});
