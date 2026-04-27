/**
 * MCP tool `node_identity_get` — Swarm Phase 1b (issue #76).
 *
 * Read-only. Returns the cryptographic identity row of THIS node so
 * peers and local tooling can quote it without touching the privkey
 * file or re-deriving the multihash.
 */
import { z } from "zod";
import type { NodeIdentityService } from "../services/node-identity.js";

export const nodeIdentityGetSchema = z.object({});

export async function nodeIdentityGet(
  service: NodeIdentityService,
  _input: unknown
) {
  const self = await service.getSelf();
  if (!self) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "No node identity initialized yet. Run `node scripts/init-node-identity.mjs` " +
            "to generate the keypair and insert the self row.",
        },
      ],
    };
  }
  const lines = [
    `node_id:      ${self.node_id}`,
    `pubkey_b64:   ${self.pubkey_b64}`,
    `display_name: ${self.display_name ?? "(unset)"}`,
    `created_at:   ${self.created_at}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
