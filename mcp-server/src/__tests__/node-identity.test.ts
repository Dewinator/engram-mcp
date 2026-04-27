import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, createPrivateKey } from "node:crypto";

import {
  base58btcEncode,
  computeNodeId,
  bootstrapNodeIdentity,
  type NodeIdentityClient,
  type NodeIdentitySelf,
  type BootstrapFs,
  type BootstrapKeypair,
} from "../services/node-identity.js";

// ---------------------------------------------------------------------------
// base58btc — the alphabet and the leading-zero rule. These are the two
// places a custom encoder typically drifts from canonical bitcoin/IPFS
// behaviour, so pin both before relying on the result for node_id.
// ---------------------------------------------------------------------------

test("base58btcEncode of empty buffer is empty string", () => {
  assert.equal(base58btcEncode(Buffer.alloc(0)), "");
});

test("base58btcEncode preserves leading zero bytes as '1'", () => {
  // Bitcoin/IPFS rule: each leading 0x00 byte becomes one leading '1' in
  // the output. Without this rule, two distinct multihashes with
  // different leading-zero counts would collide on the same string.
  assert.equal(base58btcEncode(Buffer.from([0x00])), "1");
  assert.equal(base58btcEncode(Buffer.from([0x00, 0x00])), "11");
  assert.equal(base58btcEncode(Buffer.from([0x00, 0x01])), "12");
});

test("base58btcEncode known vector: 'Hello World!'", () => {
  // Reference vector from https://en.bitcoin.it/wiki/Base58Check_encoding
  // (raw base58, no checksum). Independent confirmation that the
  // alphabet ordering is correct.
  const encoded = base58btcEncode(Buffer.from("Hello World!", "utf8"));
  assert.equal(encoded, "2NEpo7TZRRrLZSi2U");
});

// ---------------------------------------------------------------------------
// computeNodeId — wire-format contract per docs/SWARM_SPEC.md §3.5
// ---------------------------------------------------------------------------

test("computeNodeId rejects pubkeys that are not 32 bytes", () => {
  // Ed25519 raw pubkeys are exactly 32 bytes. Silently accepting wrong
  // sizes would let a bug in upstream key extraction (e.g. forgetting
  // to slice the SPKI tail) produce a node_id no peer can verify.
  assert.throws(() => computeNodeId(Buffer.alloc(31)));
  assert.throws(() => computeNodeId(Buffer.alloc(33)));
  assert.throws(() => computeNodeId(Buffer.alloc(0)));
});

test("computeNodeId is deterministic for a given pubkey", () => {
  const pub = Buffer.alloc(32, 0x42);
  assert.equal(computeNodeId(pub), computeNodeId(pub));
});

test("computeNodeId distinguishes different pubkeys", () => {
  const a = computeNodeId(Buffer.alloc(32, 0x00));
  const b = computeNodeId(Buffer.alloc(32, 0x01));
  assert.notEqual(a, b);
});

test("computeNodeId produces a 46-char base58btc string starting with 'Qm'", () => {
  // Standard sha2-256 multihash header (function-code 0x12, length 0x20)
  // plus 32 bytes of digest = 34 bytes. 34 bytes in base58btc encodes
  // to a 46-character string whose first two characters are always
  // 'Qm' — the well-known IPFS CIDv0 silhouette. Any deviation here
  // means we drifted off the multihash spec and peers will reject us.
  const id = computeNodeId(Buffer.alloc(32, 0));
  assert.equal(id.length, 46);
  assert.match(id, /^Qm/);
});

test("computeNodeId follows the SWARM_SPEC §3.5 formula exactly", () => {
  // Independent recomputation: base58btc(0x12 || 0x20 || sha256(pubkey)).
  // If this assertion ever fails the spec and the implementation have
  // diverged — that's the moment the swarm trust premise breaks.
  const pub = Buffer.alloc(32, 0xab);
  const digest = createHash("sha256").update(pub).digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  assert.equal(computeNodeId(pub), base58btcEncode(multihash));
});

// ---------------------------------------------------------------------------
// bootstrapNodeIdentity — idempotency contract
// ---------------------------------------------------------------------------

function fakePubkey(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

class FakeFs implements BootstrapFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  writes: Array<{ path: string; pem: string }> = [];

  exists(path: string): boolean {
    return this.files.has(path);
  }
  readPrivkeyPem(path: string): string {
    const v = this.files.get(path);
    if (v == null) throw new Error(`fake fs: no such file ${path}`);
    return v;
  }
  writePrivkeyPem(path: string, pem: string): void {
    this.files.set(path, pem);
    this.writes.push({ path, pem });
  }
  ensureDir(path: string): void {
    this.dirs.add(path);
  }
  // test helpers
  seedFile(path: string, pem: string): void {
    this.files.set(path, pem);
  }
  hasDir(path: string): boolean {
    return this.dirs.has(path);
  }
}

class FakeClient implements NodeIdentityClient {
  rows: Array<{
    node_id: string;
    pubkey: Buffer;
    display_name: string | null;
    created_at: string;
    is_self: boolean;
  }> = [];
  inserts = 0;

  async getSelf(): Promise<NodeIdentitySelf | null> {
    const r = this.rows.find((x) => x.is_self);
    if (!r) return null;
    return {
      node_id: r.node_id,
      pubkey_b64: r.pubkey.toString("base64"),
      display_name: r.display_name,
      created_at: r.created_at,
    };
  }
  async insertSelf(input: {
    node_id: string;
    pubkey: Buffer;
    display_name?: string | null;
  }): Promise<void> {
    this.inserts++;
    if (this.rows.some((x) => x.is_self)) {
      // The partial unique index in migration 070 enforces this on a real
      // DB. Mirror the rejection here so tests catch a logic bug that
      // would silently double-insert in CI without ever hitting Supabase.
      throw new Error("duplicate self row");
    }
    this.rows.push({
      node_id: input.node_id,
      pubkey: input.pubkey,
      display_name: input.display_name ?? null,
      created_at: new Date().toISOString(),
      is_self: true,
    });
  }
}

function realKeypairAdapter(): BootstrapKeypair {
  return {
    generate: () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const spki = publicKey.export({ type: "spki", format: "der" });
      const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
      const privateKeyPem = privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string;
      return { privateKeyPem, pubkeyRaw };
    },
    pubkeyFromPem: (pem) => {
      const pk = createPrivateKey(pem);
      // The cleanest way to derive the raw 32-byte pubkey from an Ed25519
      // privkey object is via JWK 'x' (base64url, 32 bytes). SPKI export
      // doesn't work on private keys.
      const jwk = pk.export({ format: "jwk" }) as { x?: string };
      if (!jwk.x) throw new Error("ed25519 jwk missing x");
      return Buffer.from(jwk.x, "base64url");
    },
  };
}

test("bootstrap: first run creates the self row and writes the privkey", async () => {
  const fs = new FakeFs();
  const client = new FakeClient();
  const keypair = realKeypairAdapter();
  const r = await bootstrapNodeIdentity({
    keyFile: "/tmp/fake/.mycelium/node.key",
    keyDir: "/tmp/fake/.mycelium",
    fs,
    keypair,
    client,
  });
  assert.equal(r.status, "created");
  assert.match(r.node_id, /^Qm/);
  assert.equal(client.inserts, 1);
  assert.equal(client.rows.length, 1);
  assert.equal(fs.writes.length, 1);
  assert.ok(fs.hasDir("/tmp/fake/.mycelium"));
});

test("bootstrap: second run is a no-op when the privkey file exists", async () => {
  const fs = new FakeFs();
  const client = new FakeClient();
  const keypair = realKeypairAdapter();
  // First run: real generation writes the file.
  const first = await bootstrapNodeIdentity({
    keyFile: "/tmp/fake/.mycelium/node.key",
    keyDir: "/tmp/fake/.mycelium",
    fs,
    keypair,
    client,
  });
  // Second run: same fs/client, expect no further inserts and the SAME
  // node_id (re-derived from the persisted privkey).
  const second = await bootstrapNodeIdentity({
    keyFile: "/tmp/fake/.mycelium/node.key",
    keyDir: "/tmp/fake/.mycelium",
    fs,
    keypair,
    client,
  });
  assert.equal(second.status, "already-initialized");
  assert.equal(second.node_id, first.node_id);
  assert.equal(client.inserts, 1, "second run must not insert");
  assert.equal(fs.writes.length, 1, "second run must not rewrite the privkey file");
});

test("bootstrap: refuses to create a key when the DB already has a self row", async () => {
  // Recovery scenario: privkey file deleted (lost backup) but DB still
  // claims a self identity. Generating a new keypair would orphan every
  // signature ever produced — refuse loudly, don't degrade silently.
  const fs = new FakeFs();
  const client = new FakeClient();
  await client.insertSelf({
    node_id: computeNodeId(fakePubkey(0x01)),
    pubkey: fakePubkey(0x01),
  });
  const keypair = realKeypairAdapter();
  await assert.rejects(
    () =>
      bootstrapNodeIdentity({
        keyFile: "/tmp/fake/.mycelium/node.key",
        keyDir: "/tmp/fake/.mycelium",
        fs,
        keypair,
        client,
      }),
    /inconsistent state/
  );
  assert.equal(client.inserts, 1, "must not double-insert during refusal");
});

test("bootstrap: re-derives node_id from existing privkey deterministically", async () => {
  // Pin the load-and-derive path independently from the generate path:
  // a privkey written in run N must yield the same node_id forever, so
  // an MCP tool reading the DB row and a CLI rerunning the script see
  // identical identities.
  const keypair = realKeypairAdapter();
  const { privateKeyPem, pubkeyRaw } = keypair.generate();
  const expected = computeNodeId(pubkeyRaw);

  const fs = new FakeFs();
  fs.seedFile("/tmp/fake/.mycelium/node.key", privateKeyPem);
  const client = new FakeClient();
  const r = await bootstrapNodeIdentity({
    keyFile: "/tmp/fake/.mycelium/node.key",
    keyDir: "/tmp/fake/.mycelium",
    fs,
    keypair,
    client,
  });
  assert.equal(r.status, "already-initialized");
  assert.equal(r.node_id, expected);
});
