/**
 * Per-session state for the small-model middleware (issue #4 Auto-Digest,
 * companion to N9's digest-trigger spec).
 *
 * The proxy is HTTP, so we don't have an MCP `initialize` handshake to lean
 * on for session identity. Instead we synthesize a session key from
 * `${remoteAddress}|${userAgent}` — pragmatic, stable for the lifetime of
 * a typical client run. Different clients on the same host get distinct
 * sessions through their User-Agent string.
 *
 * Once a session has been idle longer than `idleMs` (default 30min per
 * N9 §primary trigger) the digest-runner picks it up via `reapIdle()`.
 *
 * Pure data layer — no I/O. The runner (digester.ts) consumes
 * `SessionSnapshot` and decides whether to fire `record_experience`.
 */

import { randomUUID } from "node:crypto";

export interface SessionState {
  session_id:        string;       // stable UUID, lives until digest fires
  client_key:        string;       // ip|user-agent
  started_at:        number;       // first activity timestamp (ms)
  last_activity_at:  number;       // most-recent chat timestamp (ms)
  user_messages:     number;
  assistant_messages: number;
  models_seen:       Set<string>;  // ollama model IDs invoked this session
  errors:            number;       // upstream non-2xx responses
  digest_in_flight:  boolean;      // in-process advisory lock per N9 §re-entry
}

export interface SessionSnapshot {
  session_id:        string;
  client_key:        string;
  started_at:        number;
  last_activity_at:  number;
  idle_ms:           number;
  user_messages:     number;
  assistant_messages: number;
  models_seen:       string[];
  errors:            number;
}

export interface TouchInput {
  client_key:    string;
  model?:        string;            // ollama model_id
  user_present?: boolean;           // a non-empty user message exists in this turn
  upstream_ok?:  boolean;           // upstream returned 2xx
}

export interface SessionTrackerOptions {
  /** Idle threshold in ms before a session is eligible for digest. Default 30min. */
  idleMs?:  number;
  /** For tests: inject a clock. */
  now?:     () => number;
  /** Soft cap on tracked sessions; oldest evicted on overflow. Default 100. */
  maxSessions?: number;
}

const DEFAULT_IDLE_MS    = 30 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 100;

export class SessionTracker {
  private map = new Map<string, SessionState>();
  private readonly idleMs: number;
  private readonly now:    () => number;
  private readonly maxSessions: number;

  constructor(opts: SessionTrackerOptions = {}) {
    this.idleMs      = opts.idleMs      ?? DEFAULT_IDLE_MS;
    this.now         = opts.now         ?? Date.now;
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Build a session key from request properties. Public so tests + the proxy
   *  share one definition. */
  static buildKey(remoteAddr: string | undefined, userAgent: string | undefined): string {
    const ip = (remoteAddr ?? "unknown").replace(/^::ffff:/, "");  // strip IPv4-mapped-v6 prefix
    const ua = (userAgent ?? "unknown").trim().slice(0, 80);
    return `${ip}|${ua}`;
  }

  /**
   * Record activity on a session. Returns the session state so the caller
   * can read the (possibly newly-minted) session_id for downstream
   * record_experience calls.
   */
  touch(input: TouchInput): SessionState {
    const t = this.now();
    let s = this.map.get(input.client_key);
    if (!s) {
      s = {
        session_id:         randomUUID(),
        client_key:         input.client_key,
        started_at:         t,
        last_activity_at:   t,
        user_messages:      0,
        assistant_messages: 0,
        models_seen:        new Set(),
        errors:             0,
        digest_in_flight:   false,
      };
      this.map.set(input.client_key, s);
      this.evictIfFull();
    }
    s.last_activity_at = t;
    if (input.user_present) s.user_messages += 1;
    if (input.upstream_ok === true) s.assistant_messages += 1;
    if (input.upstream_ok === false) s.errors += 1;
    if (input.model) s.models_seen.add(input.model);
    return s;
  }

  /**
   * Find sessions that have been idle longer than `idleMs` and are NOT
   * already mid-digest. Returns snapshots; does NOT mutate the tracker —
   * the caller flips `digest_in_flight` via `markDigestStart` once it has
   * decided to act.
   */
  reapIdle(): SessionSnapshot[] {
    const t = this.now();
    const out: SessionSnapshot[] = [];
    for (const s of this.map.values()) {
      if (s.digest_in_flight) continue;
      const idle = t - s.last_activity_at;
      if (idle < this.idleMs) continue;
      out.push({
        session_id:         s.session_id,
        client_key:         s.client_key,
        started_at:         s.started_at,
        last_activity_at:   s.last_activity_at,
        idle_ms:            idle,
        user_messages:      s.user_messages,
        assistant_messages: s.assistant_messages,
        models_seen:        [...s.models_seen],
        errors:             s.errors,
      });
    }
    return out;
  }

  /**
   * Mark a session's digest as in-flight (advisory lock). Returns true if
   * the lock was acquired, false if another invocation already holds it.
   *
   * In-process only. Cross-process duplicate-digest protection isn't needed
   * because the middleware is single-process by design (the proxy listens
   * on one port).
   */
  markDigestStart(client_key: string): boolean {
    const s = this.map.get(client_key);
    if (!s) return false;
    if (s.digest_in_flight) return false;
    s.digest_in_flight = true;
    return true;
  }

  /**
   * Remove a session entirely after a successful digest. The next request
   * from the same client_key starts a fresh session id — that's what N9
   * §6 ("session boundary") specifies.
   */
  finishDigest(client_key: string): void {
    this.map.delete(client_key);
  }

  /** Roll back the digest-in-flight flag without removing the session
   *  — used when the digester decided to skip (silent session). */
  cancelDigest(client_key: string): void {
    const s = this.map.get(client_key);
    if (s) s.digest_in_flight = false;
  }

  /** All currently tracked sessions, for /health. */
  snapshot(): SessionSnapshot[] {
    const t = this.now();
    return [...this.map.values()].map((s) => ({
      session_id:         s.session_id,
      client_key:         s.client_key,
      started_at:         s.started_at,
      last_activity_at:   s.last_activity_at,
      idle_ms:            t - s.last_activity_at,
      user_messages:      s.user_messages,
      assistant_messages: s.assistant_messages,
      models_seen:        [...s.models_seen],
      errors:             s.errors,
    }));
  }

  /** Total tracked session count. */
  size(): number { return this.map.size; }

  private evictIfFull(): void {
    while (this.map.size > this.maxSessions) {
      // Oldest by last_activity_at — same LRU spirit as the prime cache.
      let oldestKey: string | null = null;
      let oldestT = Infinity;
      for (const [k, s] of this.map) {
        if (s.last_activity_at < oldestT) {
          oldestT = s.last_activity_at;
          oldestKey = k;
        }
      }
      if (!oldestKey) return;
      this.map.delete(oldestKey);
    }
  }
}
