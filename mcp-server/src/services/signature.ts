/**
 * Signature service — Swarm Phase 2 (issue #77).
 *
 * Reusable Ed25519 sign / verify primitives over JCS-canonicalized JSON,
 * per docs/SWARM_SPEC.md §2 (RFC 8785, RFC 8032).
 *
 * Wire-format contract (SWARM_SPEC §2.2):
 *
 *   1. Strip the `signature` field from the record.
 *   2. JCS-canonicalize the remainder (RFC 8785).
 *   3. Sign the resulting UTF-8 bytes with Ed25519.
 *   4. base64-encode the 64-byte signature; re-attach to the record.
 *
 * Verification reverses this. The canonical bytes are recomputed from the
 * received JSON — we never trust the producer's serialization. That is
 * what makes JCS load-bearing for the swarm trust premise (Verfassung
 * pillar 6, Cyber security): two honest implementations must always
 * agree on the bytes-under-signature, even if they re-order keys, round
 * floats differently in memory, or print whitespace differently on
 * transport.
 *
 * Scope discipline (issue #77 Hard constraints):
 *   - No networking, HTTP, or libp2p in this file.
 *   - This file is NOT yet integrated into existing record-creation
 *     paths (lesson synthesis, hub anchors, …). That is a follow-up.
 *   - Read-only dependency on the node identity bootstrapped by
 *     scripts/init-node-identity.mjs (issue #76); no migration touches.
 */
import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// JCS canonicalization (RFC 8785) — pure, no external deps
// ---------------------------------------------------------------------------

/**
 * Serialize a value to its RFC 8785 JSON Canonical Form (JCS).
 *
 * Compliance summary:
 *   - Object keys sorted by UTF-16 code-unit order (RFC 8785 §3.2.3).
 *     `Array.prototype.sort` without a comparator is exactly that order
 *     in ECMAScript, so a plain `.sort()` is correct here.
 *   - No whitespace, no insignificant separators (`{"a":1,"b":2}`).
 *   - Strings escaped per RFC 8259 §7 minimal-escape rules. Node's
 *     `JSON.stringify` follows those rules for valid UTF-16, including
 *     the named escapes `\b \f \n \r \t` and lowercase `\uXXXX` for
 *     other C0 control characters.
 *   - Numbers serialized via the ECMAScript Number-to-String algorithm
 *     (RFC 8785 §3.2.2.3 mandates this exact algorithm). `JSON.stringify`
 *     on a finite Number produces that representation.
 *   - Non-finite numbers (`NaN`, `±Infinity`) and `undefined` are
 *     rejected — JCS is defined only over I-JSON (RFC 7493) and silent
 *     coercion would let two implementations disagree.
 *
 * Edge case worth knowing: float-array fields (e.g. embeddings) inherit
 * the ECMAScript number serialization. Producers in other languages MUST
 * use a JCS-conformant serializer there too — see SWARM_SPEC §2.1.
 */
export function canonicalize(value: unknown): string {
  return jcs(value);
}

function jcs(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(
        `canonicalize: non-finite number not allowed by RFC 8785 / I-JSON (got ${v})`
      );
    }
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + jcs(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(
    `canonicalize: unsupported value type ${typeof v} (only JSON-representable values allowed)`
  );
}

// ---------------------------------------------------------------------------
// Ed25519 sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign a JSON record using the Ed25519 private key supplied as a PEM
 * (PKCS#8) string. Returns the 64-byte signature, base64-padded per
 * RFC 4648 §4 (matching the `signature` field encoding in SWARM_SPEC §2.3).
 *
 * The `signature` field of the record, if present, is stripped before
 * canonicalization. This mirrors the verify side and lets callers
 * re-sign records without manually deleting the field.
 *
 * Uses `crypto.sign(null, data, key)` — the Node 14+ Ed25519 API. The
 * legacy `createSign('sha256')` path does NOT work for Ed25519 because
 * Ed25519 prehashes internally and rejects an external hash algorithm.
 */
export function sign(record: object, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const bytes = Buffer.from(canonicalize(stripSignature(record)), "utf8");
  const sig = nodeSign(null, bytes, key);
  return sig.toString("base64");
}

/**
 * Verify the base64 Ed25519 signature on a JSON record against a raw
 * 32-byte public key (the on-wire `pubkey` shape from SWARM_SPEC §2.3).
 *
 * Returns true iff the signature is valid for `JCS(record − signature)`
 * under the supplied key. All other failure modes — malformed base64,
 * wrong-length signature, wrong-length pubkey, OpenSSL verify error —
 * collapse to `false`. This is intentional: a verifier MUST NOT throw on
 * bad input from the network, only refuse to trust it.
 */
export function verify(
  record: object,
  signature: string,
  publicKey: Uint8Array
): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    return false;
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  // Ed25519 signatures are exactly 64 bytes. Accepting other lengths
  // would let malformed records sneak past with a Node-internal error.
  if (sigBytes.length !== 64) return false;

  let pubKeyObj: KeyObject;
  try {
    pubKeyObj = pubkeyFromRaw(Buffer.from(publicKey));
  } catch {
    return false;
  }

  const bytes = Buffer.from(canonicalize(stripSignature(record)), "utf8");
  try {
    return nodeVerify(null, bytes, pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

/** Return a copy of `record` with the top-level `signature` field removed. */
function stripSignature(record: object): object {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const { signature: _omit, ...rest } = record as Record<string, unknown>;
  return rest;
}

/**
 * Build a Node `KeyObject` from a raw 32-byte Ed25519 public key by
 * prepending the fixed SPKI DER header. `createPublicKey` requires
 * SPKI-formatted input; the raw bytes alone are not enough.
 *
 * SPKI prefix is fixed for Ed25519 — see RFC 8410 §4.
 */
function pubkeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) {
    throw new Error(`pubkeyFromRaw: expected 32 bytes, got ${raw.length}`);
  }
  const SPKI_HEADER = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  return createPublicKey({
    key: Buffer.concat([SPKI_HEADER, raw]),
    format: "der",
    type: "spki",
  });
}

// ---------------------------------------------------------------------------
// Convenience wrapper: sign with the node's persistent self-key
// ---------------------------------------------------------------------------

export interface SignedRecord<T extends object = object> {
  /**
   * The signed payload — the original record with `signed_at` attached.
   * `signed_at` is part of the signed bytes (so receivers can reject
   * stale records); `signature` is NOT mutated into this object — the
   * caller decides whether to attach it before transport.
   */
  record: T & { signed_at: string };
  /** base64 Ed25519 signature over `JCS(record)`. */
  signature: string;
  /** ISO 8601 UTC timestamp identical to `record.signed_at`. */
  signed_at: string;
}

export interface SignWithSelfOptions {
  /** Override the privkey path. Defaults to `MYCELIUM_NODE_KEY` env var or `~/.mycelium/node.key`. */
  keyFile?: string;
  /** Inject a clock — handy for tests. Defaults to `Date.now()`. */
  now?: () => Date;
  /** Inject a PEM loader — handy for tests that don't want to touch disk. */
  loadPem?: (keyFile: string) => string;
}

/**
 * Sign a record with the node's persistent Ed25519 private key — the one
 * bootstrapped by `scripts/init-node-identity.mjs` (issue #76) at
 * `~/.mycelium/node.key` (chmod 0600).
 *
 * Attaches `signed_at` to the record BEFORE signing so it ends up inside
 * the canonical bytes (SWARM_SPEC §3 — `signed_at` is a required field
 * on every signed wire type). Returns the augmented record, the
 * signature, and the timestamp; the caller decides whether to attach
 * `signature` to the on-wire object.
 */
export function signWithSelfKey<T extends object>(
  record: T,
  options: SignWithSelfOptions = {}
): SignedRecord<T> {
  const keyFile = options.keyFile ?? defaultKeyFile();
  const loadPem = options.loadPem ?? readPemSync;
  const pem = loadPem(keyFile);
  const now = options.now ? options.now() : new Date();
  const signed_at = now.toISOString();
  const payload = { ...(record as object), signed_at } as T & {
    signed_at: string;
  };
  const signature = sign(payload, pem);
  return { record: payload, signature, signed_at };
}

/** Default privkey path. Honors `MYCELIUM_NODE_KEY` for ops overrides. */
export function defaultKeyFile(): string {
  return (
    process.env.MYCELIUM_NODE_KEY ??
    path.join(os.homedir(), ".mycelium", "node.key")
  );
}

function readPemSync(keyFile: string): string {
  return fs.readFileSync(keyFile, "utf8");
}
