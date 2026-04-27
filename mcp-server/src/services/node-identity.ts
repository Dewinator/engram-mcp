/**
 * Node identity service — Swarm Phase 1b (issue #76).
 *
 * The cryptographic identity of THIS mycelium node. The wire-format
 * convention is fixed by docs/SWARM_SPEC.md §3.5:
 *
 *   node_id = base58btc( multihash( sha2-256, pubkey_raw_bytes ) )
 *
 * The standard sha2-256 multihash is `0x12 0x20 || digest`, which
 * makes every well-formed node_id 46 base58btc characters and prefixed
 * with `Qm…` — the classic IPFS CIDv0 silhouette.
 *
 * Verfassung pillar 1 (Souveränität): the PRIVATE key never reaches
 * this layer. Bootstrap reads the raw 32-byte pubkey and forwards it;
 * the privkey stays in a chmod-600 file outside the database.
 */
import { PostgrestClient } from "@supabase/postgrest-js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// node_id derivation — pure, side-effect free
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc — Bitcoin alphabet, no checksum. Pure. */
export function base58btcEncode(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = BASE58_ALPHABET[r] + out;
  }
  return "1".repeat(zeros) + out;
}

/**
 * Compute node_id from a raw 32-byte Ed25519 public key.
 *
 * Throws on wrong length — a malformed pubkey would otherwise silently
 * produce a node_id that no peer can verify against.
 */
export function computeNodeId(pubkeyRaw: Buffer): string {
  if (pubkeyRaw.length !== 32) {
    throw new Error(
      `computeNodeId: expected 32-byte Ed25519 pubkey, got ${pubkeyRaw.length}`
    );
  }
  const digest = createHash("sha256").update(pubkeyRaw).digest();
  // multihash header for sha2-256: function-code 0x12, length 0x20.
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  return base58btcEncode(multihash);
}

// ---------------------------------------------------------------------------
// PostgREST adapter
// ---------------------------------------------------------------------------

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export interface NodeIdentitySelf {
  node_id: string;
  pubkey_b64: string;
  display_name: string | null;
  created_at: string;
}

/**
 * Minimal PostgREST surface this module needs. Lets tests inject a fake
 * without booting Supabase.
 */
export interface NodeIdentityClient {
  getSelf(): Promise<NodeIdentitySelf | null>;
  insertSelf(input: {
    node_id: string;
    pubkey: Buffer;
    display_name?: string | null;
  }): Promise<void>;
}

/**
 * Decode a PostgREST-encoded bytea response. PostgREST returns `bytea`
 * columns as `\x<hex>` strings by default.
 */
function decodeBytea(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new Error(`expected bytea string, got ${typeof value}`);
  }
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  // Fallback: some PostgREST builds may hand back base64 if the request
  // negotiated it. Keep the path open but assume hex by default.
  return Buffer.from(value, "base64");
}

export class NodeIdentityService implements NodeIdentityClient {
  private readonly db: PostgrestClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async getSelf(): Promise<NodeIdentitySelf | null> {
    const { data, error } = await this.db
      .from("nodes")
      .select("node_id, pubkey, display_name, created_at")
      .eq("is_self", true)
      .maybeSingle();
    if (error) throw new Error(`getSelf: ${fmtErr(error)}`);
    if (!data) return null;
    const pubkey = decodeBytea((data as { pubkey: unknown }).pubkey);
    return {
      node_id: (data as { node_id: string }).node_id,
      pubkey_b64: pubkey.toString("base64"),
      display_name: (data as { display_name: string | null }).display_name,
      created_at: (data as { created_at: string }).created_at,
    };
  }

  async insertSelf(input: {
    node_id: string;
    pubkey: Buffer;
    display_name?: string | null;
  }): Promise<void> {
    if (input.pubkey.length !== 32) {
      throw new Error(
        `insertSelf: expected 32-byte pubkey, got ${input.pubkey.length}`
      );
    }
    const { error } = await this.db.from("nodes").insert({
      node_id: input.node_id,
      pubkey: "\\x" + input.pubkey.toString("hex"),
      display_name: input.display_name ?? null,
      is_self: true,
    });
    if (error) throw new Error(`insertSelf: ${fmtErr(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — injectable so tests can mock fs + DB
// ---------------------------------------------------------------------------

export interface BootstrapFs {
  exists(path: string): boolean;
  readPrivkeyPem(path: string): string;
  writePrivkeyPem(path: string, pem: string): void;
  ensureDir(path: string): void;
}

export interface BootstrapKeypair {
  generate(): { privateKeyPem: string; pubkeyRaw: Buffer };
  pubkeyFromPem(pem: string): Buffer;
}

export interface BootstrapResult {
  status: "already-initialized" | "created";
  node_id: string;
  privkey_path: string;
}

/**
 * Bootstrap the node identity. Idempotent:
 *
 *   - if the privkey file is present, reload it, derive the node_id and
 *     return without touching the DB,
 *   - if the DB already has a self row but the privkey file is missing,
 *     refuse to act — that combination is unrecoverable signing-state
 *     and a human must intervene,
 *   - otherwise generate a fresh keypair, write the privkey 0600, and
 *     INSERT the self row.
 */
export async function bootstrapNodeIdentity(deps: {
  keyFile: string;
  keyDir: string;
  fs: BootstrapFs;
  keypair: BootstrapKeypair;
  client: NodeIdentityClient;
  displayName?: string | null;
}): Promise<BootstrapResult> {
  const { keyFile, keyDir, fs, keypair, client } = deps;

  if (fs.exists(keyFile)) {
    const pem = fs.readPrivkeyPem(keyFile);
    const pubkeyRaw = keypair.pubkeyFromPem(pem);
    const node_id = computeNodeId(pubkeyRaw);
    return { status: "already-initialized", node_id, privkey_path: keyFile };
  }

  // Privkey file missing. Before generating a new one, make sure the DB
  // doesn't already think it knows who this node is — generating a
  // second keypair while a self row exists would orphan every signature
  // ever produced under the original key.
  const existing = await client.getSelf();
  if (existing) {
    throw new Error(
      `inconsistent state: DB has self row (node_id=${existing.node_id}) but privkey file ${keyFile} is missing. ` +
        `Refusing to generate a new keypair — that would orphan every signature this node has ever produced. ` +
        `Restore the privkey from backup, or manually delete the self row before re-running.`
    );
  }

  fs.ensureDir(keyDir);
  const { privateKeyPem, pubkeyRaw } = keypair.generate();
  fs.writePrivkeyPem(keyFile, privateKeyPem);
  const node_id = computeNodeId(pubkeyRaw);
  await client.insertSelf({
    node_id,
    pubkey: pubkeyRaw,
    display_name: deps.displayName ?? null,
  });
  return { status: "created", node_id, privkey_path: keyFile };
}
