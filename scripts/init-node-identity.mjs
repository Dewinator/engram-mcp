#!/usr/bin/env node
/**
 * scripts/init-node-identity.mjs — Swarm Phase 1b (issue #76).
 *
 * Bootstraps the cryptographic identity of THIS mycelium node:
 *
 *   1. Generates an Ed25519 keypair (node:crypto, no extra deps).
 *   2. Writes the private key PEM to ~/.mycelium/node.key with mode 0600
 *      inside a 0700 directory. The privkey never enters the database.
 *   3. Computes node_id = base58btc(multihash(sha2-256, pubkey_raw))
 *      per docs/SWARM_SPEC.md §3.5.
 *   4. INSERTs the self-row into `nodes` (migration 070, issue #75).
 *
 * Idempotent. Running twice is safe:
 *   - if ~/.mycelium/node.key already exists, the script reloads it,
 *     re-derives node_id, prints it and exits 0.
 *   - if the DB has a self row but the privkey file is missing, the
 *     script refuses to act — that combination is unrecoverable
 *     signing-state and a human must intervene.
 *
 * Wraps `bootstrapNodeIdentity` from the compiled MCP server. Build the
 * server first: `cd mcp-server && npm run build`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateKeyPairSync,
  createPrivateKey,
} from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "mcp-server", "dist");

// Match the existing scripts/breed-agents.mjs and scripts/index-tools.mjs
// pattern: read SUPABASE_URL/KEY out of .mcp.json so a fresh shell
// without exported env vars still works.
function loadEnv() {
  try {
    const cfgPath = path.join(ROOT, ".mcp.json");
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const env = cfg.mcpServers?.["vector-memory"]?.env ?? {};
    for (const [k, v] of Object.entries(env)) process.env[k] ||= v;
  } catch (e) {
    console.warn(`! could not parse .mcp.json: ${e?.message ?? e}`);
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "✗ SUPABASE_URL and SUPABASE_KEY must be set (export them, or add to .mcp.json mcpServers.vector-memory.env)."
  );
  process.exit(1);
}

const distExists = fs.existsSync(path.join(DIST, "services/node-identity.js"));
if (!distExists) {
  console.error(
    "✗ mcp-server/dist/services/node-identity.js not found. Run `cd mcp-server && npm run build` first."
  );
  process.exit(1);
}

const { NodeIdentityService, bootstrapNodeIdentity } = await import(
  path.join(DIST, "services/node-identity.js")
);

const KEY_DIR  = path.join(os.homedir(), ".mycelium");
const KEY_FILE = path.join(KEY_DIR, "node.key");

// Real-fs adapter that mirrors the BootstrapFs interface used by the
// pure bootstrap function.
const realFs = {
  exists: (p) => fs.existsSync(p),
  readPrivkeyPem: (p) => fs.readFileSync(p, "utf8"),
  writePrivkeyPem: (p, pem) => {
    fs.writeFileSync(p, pem, { mode: 0o600 });
    // chmodSync as a belt-and-suspenders guard — depending on the
    // operator's umask, the initial mode flag may be masked off.
    fs.chmodSync(p, 0o600);
  },
  ensureDir: (p) => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    fs.chmodSync(p, 0o700);
  },
};

const realKeypair = {
  generate: () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // Ed25519 raw pubkey: last 32 bytes of the SPKI DER encoding.
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
    const privateKeyPem = privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    return { privateKeyPem, pubkeyRaw };
  },
  pubkeyFromPem: (pem) => {
    const pk = createPrivateKey(pem);
    // JWK export reveals the raw pubkey under 'x' (base64url, 32 bytes).
    const jwk = pk.export({ format: "jwk" });
    if (!jwk.x) throw new Error("ed25519 jwk export missing 'x'");
    return Buffer.from(jwk.x, "base64url");
  },
};

const client = new NodeIdentityService(SUPABASE_URL, SUPABASE_KEY);

try {
  const r = await bootstrapNodeIdentity({
    keyFile: KEY_FILE,
    keyDir: KEY_DIR,
    fs: realFs,
    keypair: realKeypair,
    client,
    displayName: process.env.MYCELIUM_NODE_DISPLAY_NAME ?? null,
  });
  if (r.status === "already-initialized") {
    console.log(`node_id already initialized: ${r.node_id}`);
    console.log(`privkey:                     ${r.privkey_path}`);
  } else {
    console.log(`✓ mycelium node identity bootstrapped`);
    console.log(`  node_id: ${r.node_id}`);
    console.log(`  privkey: ${r.privkey_path}  (chmod 0600)`);
  }
} catch (e) {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
}
