import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createPrivateKey,
  sign as nodeSign,
} from "node:crypto";

import {
  canonicalize,
  sign,
  verify,
  signWithSelfKey,
  defaultKeyFile,
} from "../services/signature.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshKeypair(): { pem: string; pubkeyRaw: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Last 32 bytes of the SPKI DER are the raw Ed25519 pubkey.
  const pubkeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { pem, pubkeyRaw };
}

// ---------------------------------------------------------------------------
// canonicalize — RFC 8785 conformance vectors
//
// The wire-format trust premise breaks the moment two implementations
// disagree on the bytes-under-signature, so we pin the small but
// load-bearing rules here rather than only relying on round-trip tests.
// ---------------------------------------------------------------------------

test("canonicalize: primitives", () => {
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
  assert.equal(canonicalize(0), "0");
  assert.equal(canonicalize(-1), "-1");
  assert.equal(canonicalize(1.5), "1.5");
  assert.equal(canonicalize("hello"), '"hello"');
  assert.equal(canonicalize(""), '""');
});

test("canonicalize: empty containers", () => {
  assert.equal(canonicalize([]), "[]");
  assert.equal(canonicalize({}), "{}");
});

test("canonicalize: object keys are sorted by UTF-16 code unit (RFC 8785 §3.2.3)", () => {
  // The pillar property: any reordering at construction time produces
  // the same canonical bytes. Without this, two honest senders writing
  // the same record in different orders would produce different
  // signatures and the swarm trust premise breaks.
  assert.equal(canonicalize({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  // Mixed casing matters — uppercase letters precede lowercase in UTF-16.
  assert.equal(canonicalize({ b: 1, A: 2 }), '{"A":2,"b":1}');
  // Sorting recurses into nested objects.
  assert.equal(
    canonicalize({ outer: { z: 1, a: 2 }, alpha: 1 }),
    '{"alpha":1,"outer":{"a":2,"z":1}}'
  );
});

test("canonicalize: arrays preserve order (only object keys are sorted)", () => {
  // RFC 8785 §3.2.4: arrays are not reordered. Reordering would change
  // the meaning of e.g. an embedding vector silently.
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalize(["b", "a", "c"]), '["b","a","c"]');
});

test("canonicalize: numbers via ECMAScript Number-to-String", () => {
  // RFC 8785 §3.2.2.3 mandates exactly the JS Number toString algorithm.
  // JSON.stringify on a finite Number returns that representation,
  // including the `1e+21` / `-0 → 0` edge cases worth pinning.
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize(0.1), "0.1");
  assert.equal(canonicalize(100), "100");
});

test("canonicalize: rejects non-finite numbers (I-JSON constraint)", () => {
  // SWARM_SPEC §2 / RFC 7493: NaN and ±Infinity are not valid JSON. A
  // silent coercion here would let one node produce bytes that no other
  // node can reproduce, so the verifier MUST refuse the input loudly.
  assert.throws(() => canonicalize(NaN), /non-finite/);
  assert.throws(() => canonicalize(Infinity), /non-finite/);
  assert.throws(() => canonicalize(-Infinity), /non-finite/);
});

test("canonicalize: rejects undefined", () => {
  // Symbols, functions, undefined — none are JSON-representable. Falling
  // back to JSON.stringify behaviour (silently dropping object keys with
  // undefined values, returning undefined for top-level undefined) would
  // make the canonical form context-dependent.
  assert.throws(() => canonicalize(undefined));
});

test("canonicalize: stringifies common JSON-escaped characters", () => {
  assert.equal(canonicalize('a"b'), '"a\\"b"');
  assert.equal(canonicalize("a\\b"), '"a\\\\b"');
  assert.equal(canonicalize("\n\r\t"), '"\\n\\r\\t"');
});

test("canonicalize: the RFC 8785 §3.2.3 example", () => {
  // From the RFC text (Appendix B example, abridged): demonstrates that
  // both key sorting and number normalization act in the same pass.
  assert.equal(
    canonicalize({ "1": "one", "10": "ten", "2": "two" }),
    '{"1":"one","10":"ten","2":"two"}'
  );
});

// ---------------------------------------------------------------------------
// sign / verify — round-trip and tamper-resistance
// ---------------------------------------------------------------------------

test("sign+verify: round-trip succeeds with the matching public key", () => {
  // The most basic property — without it nothing else matters. If this
  // ever regresses the swarm cannot exchange a single signed record.
  const { pem, pubkeyRaw } = freshKeypair();
  const record = { id: "abc", content: "hello swarm", n: 7 };
  const signature = sign(record, pem);
  assert.equal(verify(record, signature, pubkeyRaw), true);
});

test("verify: a single-byte tampering of the record fails verification", () => {
  // Verifier MUST detect mutation of any signed field. We mutate one
  // byte of a string field — this is the canonical detection surface
  // for malicious record edits in transit.
  const { pem, pubkeyRaw } = freshKeypair();
  const record = { id: "abc", content: "hello swarm", n: 7 };
  const signature = sign(record, pem);
  const tampered = { ...record, content: "Hello swarm" }; // one-byte case flip
  assert.equal(verify(tampered, signature, pubkeyRaw), false);
});

test("verify: a different field added to the record fails verification", () => {
  // Adding a field changes the JCS bytes, so the signature must be
  // rejected even if the original fields are untouched. Otherwise an
  // attacker could append claims to a signed record.
  const { pem, pubkeyRaw } = freshKeypair();
  const record = { id: "abc", content: "hello swarm" };
  const signature = sign(record, pem);
  const tampered = { ...record, extra: "claim" };
  assert.equal(verify(tampered, signature, pubkeyRaw), false);
});

test("verify: returns false when the public key does not match the signer", () => {
  // Cross-key verification must fail. This is what makes node identity
  // load-bearing in the first place — anyone can sign anything, but
  // only the holder of the private key matching `origin_node_id`'s
  // pubkey produces a signature that verifies against that pubkey.
  const a = freshKeypair();
  const b = freshKeypair();
  const record = { id: "abc", content: "hello swarm" };
  const signature = sign(record, a.pem);
  assert.equal(verify(record, signature, b.pubkeyRaw), false);
});

test("sign: signature is deterministic (Ed25519 RFC 8032 property)", () => {
  // Ed25519 is deterministic — same key + same message → same signature.
  // This isn't strictly required for security, but it lets us reason
  // about test stability and rules out a non-deterministic regression
  // (e.g. someone swapping in ECDSA without RFC 6979).
  const { pem } = freshKeypair();
  const record = { id: "abc", content: "hello swarm" };
  assert.equal(sign(record, pem), sign(record, pem));
});

test("sign: identical signature regardless of key insertion order", () => {
  // The acceptance criterion in issue #77: `{a:1, b:2}` and `{b:2, a:1}`
  // produce the same signature. This is the bytes-stability promise of
  // JCS made into an executable contract.
  const { pem } = freshKeypair();
  assert.equal(
    sign({ a: 1, b: 2 } as Record<string, number>, pem),
    sign({ b: 2, a: 1 } as Record<string, number>, pem)
  );
});

test("sign: signature is identical with or without a placeholder signature field", () => {
  // SWARM_SPEC §2.2 step 1: strip `signature` before canonicalizing.
  // Without this rule, attaching the signature to the record would
  // change the bytes-under-signature on the next sign — verifier would
  // have to know to remove it, and any "re-sign in place" path would
  // be broken.
  const { pem } = freshKeypair();
  const a = sign({ id: "abc", n: 1 }, pem);
  const b = sign({ id: "abc", n: 1, signature: "placeholder" }, pem);
  const c = sign({ id: "abc", n: 1, signature: "" }, pem);
  assert.equal(a, b);
  assert.equal(a, c);
});

test("verify: ignores the on-wire `signature` field when recomputing canonical bytes", () => {
  // Mirror of the previous test on the verify side. The transported
  // record has the signature attached; the verifier must strip it
  // before JCS-recomputing or every honest verification would fail.
  const { pem, pubkeyRaw } = freshKeypair();
  const record = { id: "abc", content: "hello swarm" };
  const signature = sign(record, pem);
  const onWire = { ...record, signature };
  assert.equal(verify(onWire, signature, pubkeyRaw), true);
});

test("verify: rejects malformed base64 signatures without throwing", () => {
  // Defense-in-depth: a verifier on the network edge must not throw on
  // garbage from a peer, only return false. Otherwise a single bad
  // record could DoS the receive path.
  const { pubkeyRaw } = freshKeypair();
  assert.equal(verify({ x: 1 }, "not!!!base64@@@", pubkeyRaw), false);
});

test("verify: rejects wrong-length signatures (must be 64 bytes)", () => {
  // Ed25519 signatures are exactly 64 bytes. Anything else is by
  // definition forged or corrupt — refuse without invoking OpenSSL.
  const { pubkeyRaw } = freshKeypair();
  const tooShort = Buffer.alloc(32, 0).toString("base64");
  const tooLong = Buffer.alloc(128, 0).toString("base64");
  assert.equal(verify({ x: 1 }, tooShort, pubkeyRaw), false);
  assert.equal(verify({ x: 1 }, tooLong, pubkeyRaw), false);
});

test("verify: rejects wrong-length public keys (must be 32 bytes)", () => {
  // Same defensive rule for the pubkey side — a 31- or 33-byte key
  // means the caller built the SPKI wrapper wrong, and we'd rather
  // surface that as `false` than as an OpenSSL error.
  const { pem } = freshKeypair();
  const signature = sign({ x: 1 }, pem);
  assert.equal(verify({ x: 1 }, signature, new Uint8Array(31)), false);
  assert.equal(verify({ x: 1 }, signature, new Uint8Array(33)), false);
  assert.equal(verify({ x: 1 }, signature, new Uint8Array(0)), false);
});

test("sign: wire-format anchor — independent re-derivation matches", () => {
  // Independent reference: build the canonical bytes by hand, sign with
  // the raw node:crypto API, base64-encode, and assert against `sign`.
  // If this ever fails, the wire-format service has drifted from the
  // primitives it composes — the moment to halt.
  const { pem, pubkeyRaw } = freshKeypair();
  const record = { z: 3, a: 1, m: 2 };
  const expectedBytes = Buffer.from('{"a":1,"m":2,"z":3}', "utf8");
  const expectedSig = nodeSign(null, expectedBytes, createPrivateKey(pem))
    .toString("base64");
  assert.equal(sign(record, pem), expectedSig);
  assert.equal(verify(record, expectedSig, pubkeyRaw), true);
});

// ---------------------------------------------------------------------------
// signWithSelfKey — convenience wrapper, dependency-injected for tests
// ---------------------------------------------------------------------------

test("signWithSelfKey: attaches signed_at and produces a verifying signature", () => {
  // The wrapper has to (a) inject signed_at INTO the signed payload so
  // receivers can reject stale records, (b) return that augmented
  // payload alongside the signature, (c) keep `signature` OUT of the
  // returned `record` (the caller decides whether to attach it before
  // transport — see SWARM_SPEC §2.2 step 4).
  const { pem, pubkeyRaw } = freshKeypair();
  const fixedNow = new Date("2026-04-27T20:01:26.605Z");
  const out = signWithSelfKey(
    { id: "abc", content: "hi" },
    {
      keyFile: "irrelevant — loadPem overrides this",
      loadPem: () => pem,
      now: () => fixedNow,
    }
  );
  assert.equal(out.signed_at, "2026-04-27T20:01:26.605Z");
  assert.equal(out.record.signed_at, out.signed_at);
  assert.equal(
    Object.prototype.hasOwnProperty.call(out.record, "signature"),
    false,
    "record must not carry the signature field — caller decides on attachment"
  );
  assert.equal(verify(out.record, out.signature, pubkeyRaw), true);
});

test("signWithSelfKey: signed_at is part of the signed bytes (mutation detected)", () => {
  // Belt-and-suspenders: if a refactor ever puts signed_at OUTSIDE the
  // signed bytes, an attacker could replay an old record under a fresh
  // timestamp. Catch that by mutating signed_at and asserting verify
  // breaks.
  const { pem, pubkeyRaw } = freshKeypair();
  const out = signWithSelfKey(
    { id: "abc", content: "hi" },
    { loadPem: () => pem, now: () => new Date("2026-04-27T20:01:26.605Z") }
  );
  const tampered = { ...out.record, signed_at: "2099-01-01T00:00:00.000Z" };
  assert.equal(verify(tampered, out.signature, pubkeyRaw), false);
});

test("defaultKeyFile: honors the MYCELIUM_NODE_KEY env override", () => {
  const prev = process.env.MYCELIUM_NODE_KEY;
  process.env.MYCELIUM_NODE_KEY = "/tmp/test-mycelium-node.key";
  try {
    assert.equal(defaultKeyFile(), "/tmp/test-mycelium-node.key");
  } finally {
    if (prev === undefined) delete process.env.MYCELIUM_NODE_KEY;
    else process.env.MYCELIUM_NODE_KEY = prev;
  }
});
