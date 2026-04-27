import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 070 — node_identity table contract pin (Swarm Phase 1a, issue #75)
//
// Why this guard exists: this migration creates the cryptographic-identity
// row that every later swarm phase depends on (provenance, signatures,
// peer discovery — see docs/SWARM_SPEC.md, NodeAdvertisement). Two
// contracts MUST hold before phase 1b writes the bootstrap row:
//
//   1. Table `nodes` exists with the documented columns and types.
//   2. The partial unique index `nodes_only_one_self` exists and is
//      conditional on `is_self`, so at most one row can ever carry
//      is_self=true.
//
// We can't run the migration from this test — the autonomy loop is
// explicitly forbidden from executing migrations (Reed runs them by hand
// after merge). What we CAN pin is the canonical SQL text that produces
// the contract. If a future edit weakens either contract, this test fails
// before the migration ever hits a real database. Same defensive pattern
// as the wire-literal pins in affect-*-event-type.test.ts.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test runs from mcp-server/dist/__tests__/, so the repo root is three
// levels up (dist/__tests__ -> dist -> mcp-server -> repo-root).
const MIGRATION_PATH = resolve(
  __dirname,
  "../../..",
  "supabase/migrations/070_node_identity.sql",
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
// or keyword-case drift (uppercase vs lowercase SQL keywords) without
// weakening the structural contracts themselves.
const SQL = SQL_NO_COMMENTS.toLowerCase().replace(/\s+/g, " ");

test("migration 070 creates the `nodes` table", () => {
  // The table name is the join key for every later swarm phase. Renaming
  // it would silently orphan provenance lookups in 1b / 2 / 3.
  assert.match(SQL, /create table if not exists nodes\b/);
});

test("nodes.node_id is TEXT PRIMARY KEY", () => {
  // node_id is the public, stable handle (multihash of the pubkey).
  // PRIMARY KEY both pins uniqueness and gives downstream FKs a
  // deterministic target column.
  assert.match(SQL, /node_id\s+text\s+primary key/);
});

test("nodes.pubkey is BYTEA NOT NULL", () => {
  // bytea, not text — Ed25519 public keys are 32 raw bytes. Storing them
  // as bytea avoids base64 round-trips at every read. NOT NULL because an
  // identity row without a pubkey is meaningless and breaks signature
  // verification before it even starts.
  assert.match(SQL, /pubkey\s+bytea\s+not null/);
});

test("nodes.display_name is TEXT (nullable, free-form)", () => {
  // display_name is informational only — not unique, not required. Pin
  // its presence and type so a future edit doesn't accidentally promote
  // it to a uniqueness key (which would break peer-list ingestion the
  // moment two operators choose the same nickname).
  assert.match(SQL, /display_name\s+text(?!\s+not null)/);
});

test("nodes.is_self is BOOLEAN NOT NULL DEFAULT FALSE", () => {
  // Defensive default: any peer we INSERT without spelling out is_self
  // must NOT take ownership of this database. A nullable column or a
  // DEFAULT TRUE would let the wrong row claim self-status and would
  // also break the partial unique index below (NULL is excluded from the
  // partial predicate, but DEFAULT TRUE would create an immediate
  // duplicate the moment a second peer is inserted).
  assert.match(SQL, /is_self\s+boolean\s+not null\s+default\s+false/);
});

test("nodes.created_at is TIMESTAMPTZ NOT NULL DEFAULT NOW()", () => {
  // Timezone-aware (timestamptz, not timestamp), server-set. Federation
  // timestamps must be unambiguous when nodes in different zones compare
  // signed_at fields against created_at.
  assert.match(SQL, /created_at\s+timestamptz\s+not null\s+default\s+now\(\)/);
});

test("partial unique index enforces 'at most one is_self row'", () => {
  // The partial unique index is THE constraint that prevents two rows
  // from claiming to be "this node". PostgreSQL has no native
  // exactly-one-true constraint; a partial unique index on a constant
  // expression with WHERE is_self does the job.
  //
  // Pinning the WHERE clause is essential — without it, the index would
  // simply forbid duplicate values of the constant `1`, which is a
  // useless (and silently broken) constraint that would let the second
  // is_self=true row through.
  assert.match(SQL, /create unique index if not exists nodes_only_one_self/);
  assert.match(SQL, /on nodes\s*\(\(1\)\)\s+where is_self/);
});

test("migration is create-only (no DROP / DELETE statements)", () => {
  // Hard rule from issue #75: the migration only creates. A stray
  // DROP TABLE or DELETE FROM in 070 would either pre-empt later schema
  // work or wipe a peer list that took weeks to accrue. Comments are
  // already stripped above, so a documentation phrase like "no DROP" in
  // the file header cannot trigger this guard.
  assert.doesNotMatch(SQL, /\bdrop\s+(table|index|column|constraint|schema)\b/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b/);
});

test("a second is_self=true row would violate the unique index", () => {
  // This is the structural-equivalent of the "two rows with is_self=true
  // fails" runtime assertion from the issue's acceptance criteria. We
  // can't run the SQL, but we CAN verify the schema-level guarantee
  // that produces that runtime behaviour:
  //
  //   * the index is UNIQUE,
  //   * indexed on a constant expression `((1))` (so every qualifying
  //     row collides on the same key),
  //   * predicated on `WHERE is_self` (so non-self rows are exempt).
  //
  // All three together imply: any second row with is_self=true gets
  // indexed at key=1 alongside the first, hits the UNIQUE violation,
  // and the INSERT fails. If any of the three drifts, this assertion
  // fails first and flags the regression at PR review time rather than
  // after the migration has already shipped.
  assert.match(
    SQL,
    /create unique index if not exists nodes_only_one_self\s+on nodes\s*\(\(1\)\)\s+where is_self/,
  );
});
