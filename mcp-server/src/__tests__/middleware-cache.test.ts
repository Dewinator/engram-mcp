import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlLruCache, buildPrimeKey } from "../middleware/prime-cache.js";

test("cache — empty cache returns undefined and counts a miss", () => {
  const c = new TtlLruCache<string>();
  assert.equal(c.get("absent"), undefined);
  assert.equal(c.stats().misses, 1);
  assert.equal(c.stats().hits, 0);
});

test("cache — set/get round-trip", () => {
  const c = new TtlLruCache<string>();
  c.set("k", "v");
  assert.equal(c.get("k"), "v");
  assert.equal(c.stats().hits, 1);
});

test("cache — TTL expires entries", () => {
  let now = 1_000_000;
  const c = new TtlLruCache<string>({ ttlMs: 1000, now: () => now });
  c.set("k", "v");
  now += 500;  assert.equal(c.get("k"), "v");        // still alive
  now += 600;  assert.equal(c.get("k"), undefined);  // expired
  assert.equal(c.stats().hits, 1);
  assert.equal(c.stats().misses, 1);
});

test("cache — LRU eviction on overflow keeps the most recently used", () => {
  const c = new TtlLruCache<string>({ maxSize: 3 });
  c.set("a", "1");
  c.set("b", "2");
  c.set("c", "3");
  // Touch a → it becomes youngest
  c.get("a");
  // Insert d → expect b (now oldest) to be evicted
  c.set("d", "4");
  assert.equal(c.get("a"), "1");
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), "3");
  assert.equal(c.get("d"), "4");
  assert.ok(c.stats().evictions >= 1);
});

test("cache — clear() drops entries but not stats", () => {
  const c = new TtlLruCache<string>();
  c.set("k", "v");
  c.get("k");          // 1 hit
  c.clear();
  assert.equal(c.get("k"), undefined);
  const s = c.stats();
  assert.equal(s.current_size, 0);
  assert.equal(s.hits, 1);          // lifetime stat preserved
  assert.equal(s.misses, 1);
});

test("cache — stats shape is stable", () => {
  const c = new TtlLruCache<string>({ ttlMs: 99, maxSize: 7 });
  const s = c.stats();
  assert.equal(typeof s.hits, "number");
  assert.equal(typeof s.misses, "number");
  assert.equal(typeof s.evictions, "number");
  assert.equal(s.current_size, 0);
  assert.equal(s.max_size, 7);
  assert.equal(s.ttl_ms, 99);
});

test("buildPrimeKey — whitespace + case normalisation", () => {
  assert.equal(buildPrimeKey("Hello World",  "research"),
               buildPrimeKey("hello   world", "RESEARCH"));
  // Different task description → different key
  assert.notEqual(buildPrimeKey("foo", "x"), buildPrimeKey("bar", "x"));
  // Different task type → different key
  assert.notEqual(buildPrimeKey("foo", "x"), buildPrimeKey("foo", "y"));
});

test("buildPrimeKey — undefined inputs collapse to a stable empty key", () => {
  // Key for "no description, no type" should be a single deterministic string
  // — used when a chat opens with nothing but a system message.
  const k = buildPrimeKey(undefined, undefined);
  assert.equal(typeof k, "string");
  assert.equal(buildPrimeKey(undefined, undefined), buildPrimeKey("", ""));
});
