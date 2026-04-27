/**
 * In-memory TTL + LRU cache for the prime-context block (issue #7, N7).
 *
 * The middleware (N2) calls `PrimeFetcher.buildAndFormat` on every chat
 * request. That hits Supabase for `prime_context_static`, the affect
 * singleton, two recall RPCs, and Ollama for the embedding — call it
 * 200-400ms per request on warm caches, more on cold. For a back-and-forth
 * dialogue most of those calls return identical data.
 *
 * This cache short-circuits the fetch when the same task description has
 * been primed within `ttlMs`. Pure in-memory; no Redis, no shared state
 * across processes — the proxy is single-process by design.
 *
 * Key shape: `${normalize(taskDescription)}::${taskType ?? ""}`
 *
 * What we DON'T cache:
 *  - The agent's static block alone — it changes whenever a digest fires.
 *    A cache that ignored task description would serve stale memories.
 *  - The full LLM response — that depends on the model and is not our job.
 *
 * What's deferred to a follow-up (issue body §"Drift-Invalidation"):
 *  - Embedding-drift detection: when the user changes topic significantly,
 *    cosine(new_embedding, cached_key_embedding) drops. We could miss-on-
 *    drift instead of just TTL. Adds complexity and an extra embed call —
 *    not worth it until we have data showing TTL alone is insufficient.
 */

export interface CacheStats {
  hits:       number;
  misses:     number;
  evictions:  number;
  current_size: number;
  max_size:     number;
  ttl_ms:       number;
}

interface Entry<V> {
  value:     V;
  expires_at: number;
  /** Insertion / last-access tick — used for LRU ordering. */
  tick:      number;
}

export interface PrimeCacheOptions {
  ttlMs?:    number;
  maxSize?:  number;
  /** For tests: inject a clock so time-dependent behavior is testable. */
  now?:      () => number;
}

const DEFAULT_TTL_MS  = 5 * 60 * 1_000;   // 5 minutes per issue body
const DEFAULT_MAX     = 200;              // ~50KB at 250 bytes/entry — cheap

/**
 * Generic TTL+LRU cache. Generic so the same primitive is reusable for
 * other middleware caches (e.g. an embedding cache later) without
 * duplicating the eviction logic.
 */
export class TtlLruCache<V> {
  private map = new Map<string, Entry<V>>();
  private tickCounter = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly ttlMs:   number;
  private readonly maxSize: number;
  private readonly now:     () => number;

  constructor(opts: PrimeCacheOptions = {}) {
    this.ttlMs   = opts.ttlMs   ?? DEFAULT_TTL_MS;
    this.maxSize = opts.maxSize ?? DEFAULT_MAX;
    this.now     = opts.now     ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expires_at <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU bump — touching an entry makes it youngest.
    entry.tick = ++this.tickCounter;
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    const expires_at = this.now() + this.ttlMs;
    const tick = ++this.tickCounter;
    this.map.set(key, { value, expires_at, tick });
    this.evictIfFull();
  }

  /** Drop everything. Useful for tests + manual cache invalidation. */
  clear(): void {
    this.map.clear();
    // Stats are NOT reset — they reflect the lifetime of the cache, not the
    // contents.
  }

  stats(): CacheStats {
    return {
      hits:         this.hits,
      misses:       this.misses,
      evictions:    this.evictions,
      current_size: this.map.size,
      max_size:     this.maxSize,
      ttl_ms:       this.ttlMs,
    };
  }

  private evictIfFull(): void {
    while (this.map.size > this.maxSize) {
      // Find the entry with the smallest tick (= oldest by access order).
      let oldestKey: string | null = null;
      let oldestTick = Infinity;
      for (const [k, v] of this.map) {
        if (v.tick < oldestTick) {
          oldestTick = v.tick;
          oldestKey = k;
        }
      }
      if (!oldestKey) return;
      this.map.delete(oldestKey);
      this.evictions += 1;
    }
  }
}

/**
 * Build a stable cache key for prime-context lookups. Whitespace-normalised
 * + lowercased so trivially different inputs ("hello" vs "Hello   ") share
 * a cache slot — precision over recall here is fine because the prime block
 * is observation, not factual ground truth.
 */
export function buildPrimeKey(taskDescription: string | undefined, taskType: string | undefined): string {
  const t = (taskDescription ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const tt = (taskType ?? "").trim().toLowerCase();
  return `${t}::${tt}`;
}
