/**
 * Integration tests for the /.well-known/mycelium-node endpoint
 * (Swarm Phase 3c, issue #87).
 *
 * Boots a real `node:http` server, registers the handler, and curls it
 * via global `fetch`. The point of going end-to-end (rather than
 * unit-testing `buildNodeAdvertisementResponse` in isolation) is to
 * verify the wiring contract from §4.1 / §4.5: status, content-type,
 * cache-control, body shape, multihash invariant, and signature
 * verification — all observable to a peer that knows nothing about our
 * internals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";

import { buildNodeAdvertisementResponse } from "../swarm/endpoints/node-advertisement.js";
import { computeNodeId } from "../services/node-identity.js";
import { signWithSelfKey, verify } from "../services/signature.js";
import { WIRE_SPEC_VERSION } from "../services/wire-types.js";

// ---------------------------------------------------------------------------
// Identity fixture — fresh keypair per test, no shared state
// ---------------------------------------------------------------------------

interface Identity {
  pem: string;
  pubkeyRaw: Uint8Array;
  pubkeyB64: string;
  nodeId: string;
}

function freshIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Last 32 bytes of the SPKI DER are the raw Ed25519 pubkey — same
  // extraction the wire-validator tests use.
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubkeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    pem,
    pubkeyRaw,
    pubkeyB64: Buffer.from(pubkeyRaw).toString("base64"),
    nodeId: computeNodeId(Buffer.from(pubkeyRaw)),
  };
}

/**
 * Boot a one-route HTTP server on an ephemeral port, return the base URL
 * and a teardown fn. Resolves the port AFTER `listen()` has bound — the
 * fetch URL is therefore guaranteed to point at the running server.
 */
async function bootServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/mycelium-node" && req.method === "GET") {
      void handler(req, res).catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server bind failed");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  return { url, close };
}

// ---------------------------------------------------------------------------
// Happy path — full §4.1 contract
// ---------------------------------------------------------------------------

test("GET /.well-known/mycelium-node returns a valid self-signed advertisement", async () => {
  const self = freshIdentity();

  const { url, close } = await bootServer(async (_req, res) => {
    const result = await buildNodeAdvertisementResponse({
      loadSelf: async () => ({
        node_id: self.nodeId,
        pubkey_b64: self.pubkeyB64,
      }),
      // Inject the fresh PEM via signWithSelfKey's `loadPem` so the
      // signature path is exercised exactly as production runs it,
      // minus the disk read.
      signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
      publicUrl: "https://node.example.com",
      displayName: "test-node",
    });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });

  try {
    const response = await fetch(`${url}/.well-known/mycelium-node`);

    // Status + headers — §4.1 + §4.5
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/json; charset=utf-8"
    );
    assert.equal(response.headers.get("cache-control"), "no-store");

    // Body parses, has every required NodeAdvertisement field.
    const body = (await response.json()) as Record<string, unknown>;
    for (const field of [
      "node_id",
      "pubkey",
      "endpoint_url",
      "spec_version",
      "signed_at",
      "signature",
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(body, field),
        `missing required field "${field}"`
      );
    }
    assert.equal(body.spec_version, WIRE_SPEC_VERSION);
    assert.equal(body.endpoint_url, "https://node.example.com");
    assert.equal(body.display_name, "test-node");

    // `signed_at` must be ISO 8601 UTC with millisecond precision and `Z`
    // suffix per the §3 type table.
    assert.match(
      body.signed_at as string,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );

    // multihash invariant — rule 6 of §5. We hash the on-wire pubkey
    // (decoded from unpadded base64url) and assert it round-trips to
    // node_id. Same helper Phase 1b introduced — no new crypto here.
    const pubkeyOnWire = Buffer.from(body.pubkey as string, "base64url");
    assert.equal(pubkeyOnWire.length, 32);
    assert.equal(computeNodeId(pubkeyOnWire), body.node_id);

    // Signature verifies via Phase 2's verifier against the on-wire
    // pubkey. `verify` strips `signature` internally and JCS-recomputes
    // the bytes, so this is exactly what a peer would do.
    const sigOk = verify(
      body,
      body.signature as string,
      new Uint8Array(pubkeyOnWire)
    );
    assert.equal(sigOk, true, "signature did not verify against on-wire pubkey");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 503 cases — the spec is silent on the exact code, but the issue body
// pins MYCELIUM_PUBLIC_URL missing → 503; we extend that pattern to
// every "not yet ready" mode so the operator gets a deterministic
// signal instead of a 200 with an unsigned shell.
// ---------------------------------------------------------------------------

test("returns 503 when MYCELIUM_PUBLIC_URL is missing", async () => {
  const self = freshIdentity();
  const result = await buildNodeAdvertisementResponse({
    loadSelf: async () => ({ node_id: self.nodeId, pubkey_b64: self.pubkeyB64 }),
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
    publicUrl: undefined,
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /MYCELIUM_PUBLIC_URL/);
});

test("returns 503 when no self-row exists in `nodes`", async () => {
  const result = await buildNodeAdvertisementResponse({
    loadSelf: async () => null,
    publicUrl: "https://node.example.com",
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /not initialized/);
});

test("returns 503 when display_name exceeds the §3.3 64-char cap", async () => {
  const self = freshIdentity();
  const result = await buildNodeAdvertisementResponse({
    loadSelf: async () => ({ node_id: self.nodeId, pubkey_b64: self.pubkeyB64 }),
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
    publicUrl: "https://node.example.com",
    displayName: "x".repeat(65),
  });
  assert.equal(result.status, 503);
  const body = JSON.parse(result.body) as { error?: string };
  assert.match(body.error ?? "", /64/);
});

test("omits display_name from the wire body when not configured", async () => {
  const self = freshIdentity();
  const result = await buildNodeAdvertisementResponse({
    loadSelf: async () => ({ node_id: self.nodeId, pubkey_b64: self.pubkeyB64 }),
    signRecord: (r) => signWithSelfKey(r, { loadPem: () => self.pem }),
    publicUrl: "https://node.example.com",
    displayName: null,
  });
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body) as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, "display_name"),
    false,
    "display_name should not appear when not configured (it's optional in §3.3)"
  );
  // And the signature still verifies — making sure we did not silently
  // include an empty display_name in the canonical bytes.
  const pubkeyOnWire = Buffer.from(body.pubkey as string, "base64url");
  const sigOk = verify(body, body.signature as string, new Uint8Array(pubkeyOnWire));
  assert.equal(sigOk, true);
});
