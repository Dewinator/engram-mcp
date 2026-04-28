/**
 * GET /.well-known/mycelium-node — Swarm Phase 3c (issue #87).
 *
 * Serves THIS node's self-signed `NodeAdvertisement` per SWARM_SPEC §3.3
 * and §4.1. First end-to-end wire-path: a peer can curl this endpoint,
 * verify `multihash(pubkey) == node_id`, and verify the Ed25519 signature
 * over `JCS(record − signature)` — no out-of-band trust root needed.
 *
 * Composes Phase 1b (`NodeIdentityService.getSelf`) and Phase 2
 * (`signWithSelfKey` from `services/signature.ts`). Does NOT touch any
 * key material itself: the privkey stays in `~/.mycelium/node.key`,
 * the DB row stays untouched, and a missing self-row surfaces as 503
 * — never as a silent re-bootstrap (issue §"Hard constraints").
 */
import {
  signWithSelfKey,
  type SignedRecord,
} from "../../services/signature.js";
import {
  WIRE_SPEC_VERSION,
  type NodeAdvertisement,
} from "../../services/wire-types.js";

/**
 * What the handler needs from the rest of the system. Injected so the
 * tests can exercise the full path without standing up Supabase or
 * touching `~/.mycelium/node.key`.
 */
export interface NodeAdvertisementDeps {
  /**
   * Load the self-row from the `nodes` table (`is_self = true`). Returns
   * null when the node has not been bootstrapped yet — the handler
   * answers 503 instead of generating a key.
   */
  loadSelf: () => Promise<{ node_id: string; pubkey_b64: string } | null>;
  /**
   * Sign an unsigned record with the node's persistent self-key.
   * Defaults to `signWithSelfKey` (reads `MYCELIUM_NODE_KEY` or
   * `~/.mycelium/node.key`).
   */
  signRecord?: <T extends object>(record: T) => SignedRecord<T>;
  /**
   * `MYCELIUM_PUBLIC_URL` — the absolute https:// URL where this node's
   * swarm endpoints are reachable (§3.3 `endpoint_url`). Required;
   * missing value is a 503, not a silent fallback. The handler does NOT
   * validate that the URL begins with `https://` — that is rejection
   * rule 13 of §5 and is a receiver-side concern; emitting an http URL
   * here would still produce a record that fails on verify, which is
   * the correct failure mode rather than silently rewriting the value.
   */
  publicUrl: string | undefined;
  /**
   * `MYCELIUM_DISPLAY_NAME` — optional human-friendly label, ≤ 64 chars
   * (§3.3 size cap; rule 12 of §5). Names longer than the cap are
   * rejected up front so the node never publishes a record the
   * validator would drop.
   */
  displayName?: string | null;
}

export interface HttpResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

/**
 * Build the response for `GET /.well-known/mycelium-node`. Returns an
 * HTTP-shaped triple (`status` / `headers` / `body`) so the surrounding
 * HTTP server can write it without further policy. The endpoint is
 * unauthenticated and idempotent (§4.1) — every error mode is
 * operator-readable, not opaque, so a peer trying to debug a discovery
 * failure can see exactly which precondition is missing.
 */
export async function buildNodeAdvertisementResponse(
  deps: NodeAdvertisementDeps
): Promise<HttpResponseShape> {
  if (!deps.publicUrl) {
    return jsonResponse(503, { error: "MYCELIUM_PUBLIC_URL not configured" });
  }
  if (deps.displayName != null && deps.displayName.length > 64) {
    return jsonResponse(503, {
      error: "MYCELIUM_DISPLAY_NAME exceeds 64 characters (SWARM_SPEC §3.3)",
    });
  }

  let self: { node_id: string; pubkey_b64: string } | null;
  try {
    self = await deps.loadSelf();
  } catch (e) {
    return jsonResponse(503, {
      error: "loadSelf failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  if (!self) {
    return jsonResponse(503, {
      error:
        "node identity not initialized; run scripts/init-node-identity.mjs first",
    });
  }

  // The wire format encodes the pubkey as unpadded base64url (§3.3); the
  // DB stores raw bytes that `NodeIdentityService` surfaces as standard
  // padded base64. Re-encode here so a peer hashing the on-wire pubkey
  // recovers exactly the bytes the DB row was built from — that is the
  // invariant rule 6 of §5 enforces on the receiver.
  const pubkeyRaw = Buffer.from(self.pubkey_b64, "base64");
  if (pubkeyRaw.length !== 32) {
    return jsonResponse(503, {
      error: `self pubkey is ${pubkeyRaw.length} bytes; expected 32 (Ed25519)`,
    });
  }
  const pubkeyB64Url = pubkeyRaw.toString("base64url");

  // Build the unsigned record. `signed_at` is added by the signer so it
  // lands inside the canonical bytes (§2.2 step 1: the signature is
  // computed over the record minus the signature field).
  const unsigned: Omit<NodeAdvertisement, "signed_at" | "signature"> & {
    display_name?: string;
  } = {
    node_id: self.node_id,
    pubkey: pubkeyB64Url,
    endpoint_url: deps.publicUrl,
    spec_version: WIRE_SPEC_VERSION,
  };
  if (deps.displayName) unsigned.display_name = deps.displayName;

  const signer = deps.signRecord ?? signWithSelfKey;
  let signed: SignedRecord<typeof unsigned>;
  try {
    signed = signer(unsigned);
  } catch (e) {
    return jsonResponse(503, {
      error: "signing failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const advertisement: NodeAdvertisement = {
    ...signed.record,
    signature: signed.signature,
  };
  return {
    status: 200,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(advertisement),
  };
}

function jsonResponse(status: number, body: unknown): HttpResponseShape {
  return {
    status,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(body),
  };
}
