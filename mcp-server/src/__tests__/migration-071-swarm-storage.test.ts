import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 071 — swarm storage contract pin (Swarm Phase 3d, issue #88)
//
// Why this guard exists: this migration creates the on-disk floor for every
// later /swarm/lessons and /swarm/hubs endpoint. Three contracts MUST hold
// before the Phase 3/4 endpoints write or read against it:
//
//   1. The two new tables (swarm_lessons, swarm_hub_anchors) exist with
//      every column docs/SWARM_SPEC.md §3.1 / §3.2 declares, in the right
//      types, with the right NOT NULLs.
//   2. Every column-level CHECK that maps to a §5 rejection rule is
//      present at the DB level — content size cap (rule 12), embedding
//      dimension (768, rule 4), synthesized_from_cluster_size >= 2 (rule
//      11), signed_at >= created_at (rule 9), hub_score 0..1, etc.
//   3. No `trust_edges`/TrustEdge table exists. SWARM_SPEC §3.4 forbids
//      putting trust on the wire; introducing such a table would create
//      the temptation to JOIN it into a wire response.
//
// Same defensive pattern as migration-070-node-identity.test.ts — read the
// SQL, normalise it, regex-pin the structural contract. We can't run the
// migration here (the autonomy loop is forbidden from executing migrations,
// Reed runs them by hand after merge), but we CAN make sure a future edit
// can never silently weaken the contract these endpoints depend on.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/071_swarm_storage.sql",
);
const SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
// Strip line and block comments BEFORE keyword checks so a phrase like
// "no DROP, no DELETE" inside a comment cannot accidentally satisfy or
// violate a structural assertion.
const SQL_NO_COMMENTS = SQL_RAW.replace(/--[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
// Lowercase + collapsed whitespace makes the assertions robust to indent
// or keyword-case drift without weakening the structural contracts.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (1) nodes — peer + local-trust columns (extends migration 070)
// ---------------------------------------------------------------------------

test("migration 071 extends `nodes` with peer + local-trust columns", () => {
  // pubkey_b64url: §3.3 wire encoding, mirrored from raw `pubkey` BYTEA.
  // Nullable because legacy rows from migration 070 don't have it yet.
  assert.match(SQL, /alter table nodes\s+add column if not exists pubkey_b64url\s+text\b/);
  // endpoint_url: §3.3 https-url base for /swarm/* endpoints. Nullable —
  // peers we haven't fully advertised yet still get a row.
  assert.match(SQL, /alter table nodes\s+add column if not exists endpoint_url\s+text\b/);
  // last_seen_at: nullable — we may know about a peer we haven't reached.
  assert.match(SQL, /alter table nodes\s+add column if not exists last_seen_at\s+timestamptz\b/);
  // trust_weight: §3.4 TrustEdge.weight, with safe DEFAULT 0.5 so the
  // existing is_self bootstrap row gets a neutral value without backfill.
  assert.match(
    SQL,
    /alter table nodes\s+add column if not exists trust_weight\s+real\s+not null\s+default\s+0\.5\b/,
  );
  // trust_reason: §3.4 free-form audit note. Nullable.
  assert.match(SQL, /alter table nodes\s+add column if not exists trust_reason\s+text\b/);
});

// ---------------------------------------------------------------------------
// (2) swarm_lessons — §3.1 mirror, with §5 rejection-rule CHECKs
// ---------------------------------------------------------------------------

test("swarm_lessons table exists with every required §3.1 column", () => {
  assert.match(SQL, /create table if not exists swarm_lessons\b/);
  // Renaming the table would orphan every later endpoint. Pin the name.
  assert.match(SQL, /id\s+uuid\s+primary key\b/);
  // content: §3.1 ≤ 8 KiB (8192 octets) → §5 rule 12 enforced at column.
  assert.match(
    SQL,
    /content\s+text\s+not null\s+check\s*\(\s*octet_length\s*\(\s*content\s*\)\s*<=\s*8192\s*\)/,
  );
  // embedding: §3.6 fixes 768-d nomic-embed-text. Wrong dim = §5 rule 4.
  assert.match(SQL, /embedding\s+vector\s*\(\s*768\s*\)\s+not null\b/);
  // synthesized_from_cluster_size: §3.1 says ≥ 1, §5 rule 11 says wire
  // floor is 2. Enforce the wire floor at the DB so a misbehaving local
  // synthesiser can't insert a single-source "lesson" that would later
  // be re-served as wire-illegal.
  assert.match(
    SQL,
    /synthesized_from_cluster_size\s+int\s+not null\s+check\s*\(\s*synthesized_from_cluster_size\s*>=\s*2\s*\)/,
  );
  // origin_node_id: provenance handle. FK to nodes(node_id) prevents
  // dangling lesson rows when a peer is purged; pinning the FK target
  // protects against a future rename of the parent column.
  assert.match(
    SQL,
    /origin_node_id\s+text\s+not null\s+references nodes\s*\(\s*node_id\s*\)/,
  );
  assert.match(SQL, /signed_at\s+timestamptz\s+not null\b/);
  assert.match(SQL, /created_at\s+timestamptz\s+not null\b/);
  assert.match(SQL, /signature\s+text\s+not null\b/);
  // tags: §3.1 optional, hence no NOT NULL.
  assert.match(SQL, /tags\s+text\[\]/);
  assert.match(SQL, /spec_version\s+text\s+not null\b/);
  // received_at: local bookkeeping, server-set so a malicious peer can't
  // forge it. NOT NULL DEFAULT NOW() means INSERT can omit it.
  assert.match(SQL, /received_at\s+timestamptz\s+not null\s+default\s+now\s*\(\s*\)/);
  // signature_verified_at: nullable. Set by the wire-validator (PR #89)
  // after Ed25519 verify succeeds; NULL means "not yet verified".
  assert.match(SQL, /signature_verified_at\s+timestamptz\b/);
});

test("swarm_lessons enforces signed_at >= created_at (§5 rule 9, defense in depth)", () => {
  // §5 rule 9 says wire records with signed_at < created_at must be
  // dropped. The wire-validator already checks this; we re-enforce at the
  // DB so a bug in the validator can't silently land a backdated row.
  assert.match(
    SQL,
    /check\s*\(\s*signed_at\s*>=\s*created_at\s*\)/,
  );
});

test("swarm_lessons has the indexes /swarm/lessons §4.3 needs", () => {
  // (signed_at) — supports the ?since= query parameter.
  assert.match(
    SQL,
    /create index if not exists swarm_lessons_signed_at_idx\s+on swarm_lessons\s*\(\s*signed_at\s*\)/,
  );
  // (origin_node_id, signed_at) — supports duplicate-detection (§5 rule 10:
  // duplicate id with different signature for same origin + signed_at).
  assert.match(
    SQL,
    /create index if not exists swarm_lessons_origin_signed_at_idx\s+on swarm_lessons\s*\(\s*origin_node_id\s*,\s*signed_at\s*\)/,
  );
  // HNSW vector_cosine_ops — supports the ?topic= query parameter and
  // matches every other embedding index in the codebase (memories,
  // experiences, lessons, soul_traits — migrations 002, 004, 015, 017).
  assert.match(
    SQL,
    /create index if not exists swarm_lessons_embedding_hnsw\s+on swarm_lessons using hnsw\s*\(\s*embedding\s+vector_cosine_ops\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (3) swarm_hub_anchors — §3.2 mirror, with §5 range CHECKs
// ---------------------------------------------------------------------------

test("swarm_hub_anchors table exists with every required §3.2 column", () => {
  assert.match(SQL, /create table if not exists swarm_hub_anchors\b/);
  // §3.2 has no `id` field — it's a pointer, not data. Use a local
  // BIGSERIAL for storage identity; do NOT expose this on the wire.
  assert.match(SQL, /id\s+bigserial\s+primary key\b/);
  assert.match(SQL, /embedding\s+vector\s*\(\s*768\s*\)\s+not null\b/);
  // hub_score: §3.2 says 0..1. Range check is the analogue of the
  // wire-validator's domain check.
  assert.match(
    SQL,
    /hub_score\s+real\s+not null\s+check\s*\(\s*hub_score\s*>=\s*0\s+and\s+hub_score\s*<=\s*1\s*\)/,
  );
  // local_memory_count: §3.2 says ≥ 1.
  assert.match(
    SQL,
    /local_memory_count\s+int\s+not null\s+check\s*\(\s*local_memory_count\s*>=\s*1\s*\)/,
  );
  // topic_label: §3.2 ≤ 256 chars, optional → §5 rule 12 (size cap).
  assert.match(
    SQL,
    /topic_label\s+text\s+check\s*\(\s*topic_label\s+is\s+null\s+or\s+octet_length\s*\(\s*topic_label\s*\)\s*<=\s*256\s*\)/,
  );
  assert.match(
    SQL,
    /origin_node_id\s+text\s+not null\s+references nodes\s*\(\s*node_id\s*\)/,
  );
  assert.match(SQL, /signed_at\s+timestamptz\s+not null\b/);
  assert.match(SQL, /signature\s+text\s+not null\b/);
  assert.match(SQL, /spec_version\s+text\s+not null\b/);
  assert.match(SQL, /received_at\s+timestamptz\s+not null\s+default\s+now\s*\(\s*\)/);
  assert.match(SQL, /signature_verified_at\s+timestamptz\b/);
});

test("swarm_hub_anchors has an HNSW embedding index", () => {
  assert.match(
    SQL,
    /create index if not exists swarm_hub_anchors_embedding_hnsw\s+on swarm_hub_anchors using hnsw\s*\(\s*embedding\s+vector_cosine_ops\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (4) Acceptance-criteria probes (issue #88)
// ---------------------------------------------------------------------------

test("acceptance: cluster_size = 1 fails the CHECK (§5 rule 11 floor)", () => {
  // Issue #88 acceptance: "Inserting a lesson with
  // synthesized_from_cluster_size = 1 fails the check constraint."
  // We can't run the INSERT, but we CAN pin the constraint that produces
  // the runtime behaviour: a CHECK that mandates >= 2 on the column.
  // CHECK ( ... < 2 ... ) would weaken the floor to "anything below"; we
  // must see ">=" with a "2" RHS specifically.
  assert.match(
    SQL,
    /check\s*\(\s*synthesized_from_cluster_size\s*>=\s*2\s*\)/,
  );
  assert.doesNotMatch(SQL, /synthesized_from_cluster_size\s*>=\s*1\s*\)/);
});

test("acceptance: signed_at < created_at fails the CHECK (§5 rule 9)", () => {
  // Issue #88 acceptance: "Inserting a lesson with signed_at < created_at
  // fails the check constraint." The single table-level CHECK enforces
  // both halves of the inequality at once.
  assert.match(
    SQL,
    /check\s*\(\s*signed_at\s*>=\s*created_at\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// (5) Hard-rule guards
// ---------------------------------------------------------------------------

test("comment on table references docs/SWARM_SPEC.md for both new tables", () => {
  // The `comment on table` clause is the in-DB pointer back to the spec.
  // Drift between SQL and spec is the failure mode this catches.
  assert.match(SQL, /comment on table swarm_lessons\s+is\s+'/);
  assert.match(SQL, /comment on table swarm_hub_anchors\s+is\s+'/);
  // Both comments must point readers to the spec file.
  const docsRefs = SQL.match(/docs\/swarm_spec\.md/g) ?? [];
  assert.ok(
    docsRefs.length >= 2,
    `expected each table comment to reference docs/SWARM_SPEC.md, got ${docsRefs.length} reference(s)`,
  );
});

test("migration is create-only (no DROP / DELETE statements)", () => {
  // Hard rule from issue #88: only CREATE / ALTER ADD. A stray DROP or
  // DELETE would either pre-empt later schema work or wipe a swarm
  // ingestion log. Comments are stripped above so prose like "no DROP" in
  // the file header cannot trigger this guard.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|column|constraint|schema)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
});

test("no TrustEdge / trust_edges table — §3.4 forbids trust on the wire", () => {
  // SWARM_SPEC §3.4: "There is intentionally no HTTP endpoint that returns
  // TrustEdge records." A separate trust_edges table would create the
  // temptation to JOIN it into a wire response. Trust lives in the flat
  // nodes.trust_weight / nodes.trust_reason columns instead.
  assert.doesNotMatch(SQL, /create table[^;]+\btrust_edges?\b/);
});
