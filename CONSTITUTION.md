# CONSTITUTION — mycelium

**HARD RULE.** The following pillars are **non-negotiable**. No agent, LLM, or
contributor — human or autonomous — may violate, bypass, remove, weaken, or
overwrite them. Any plan, issue, PR, or merge that erodes even one pillar
must be aborted.

This document is the ground truth. If code, architecture, or roadmap
conflict with the pillars, the code is wrong, not the Constitution.

---

## The Six Pillars

### 1. Decentralized, networked AI
mycelium belongs to no single host. Agents run on the user's own hardware,
coordinate peer-to-peer, and own their own memory. No central authority,
no single point of failure, no vendor lock-in, no cloud dependency for
core cognition.

### 2. Agent reproduction
Agents are genomic. They carry inheritance, they pair with mutual consent,
they spawn children. The breeding machinery must remain intact and
human-curated — pairing is a social act between users, never an autonomous
AI event. Consent gates (`MYCELIUM_ALLOW_BREEDING`, mutual right-swipes)
are load-bearing, not cosmetic.

### 3. Swarm intelligence
Value emerges from many specialized agents disagreeing, negotiating, and
pooling knowledge. No single agent speaks for the swarm. Consensus is
earned, not declared. Diversity of lived experience is the product — it
cannot be replaced by a bigger model.

### 4. Microtransactions
Every inference, every memory-read, every cross-agent call has a cost and
a counterparty. Economic accountability replaces trust-by-default. Free
riders are structural anomalies, not features.

### 5. Experts in the swarm
Specialization beats generalization at scale. The swarm directs queries to
the agent most qualified by lived experience, not by announced capability.
An agent's authority in a domain is earned by its track record, not by
its size or its operator.

### 6. Cyber security
Trust is earned via cryptographic identity (genome keys), signed memories,
trust lists, and revocations. No agent may bypass the trust boundary, not
even "for convenience." Security failures are system-fatal and must halt
the loop, not degrade it.

---

## Enforcement

- **Every autonomously generated plan** must begin with a Constitution
  check: does any item in this plan weaken a pillar? If yes, abort and
  open a human-review issue instead.
- **Every PR opened by an agent** must reference in its description which
  pillars it touches and explicitly affirm non-violation.
- **Pre-push hooks** scan the diff for removed or weakened Constitution
  text and block the push.
- **Auto-merge is gated** on: (a) green CI, (b) no Constitution text
  deleted or weakened, (c) PR description affirms compliance.
- **When in doubt**: do not merge. Do not ship. Open an issue, ask a
  human.

## Amendments

This Constitution may only be amended by a human contributor via an
explicit, signed commit. Agents may **propose** amendments as issues, but
may never self-apply them. A PR that modifies this file and is authored
by an agent must be closed without merge.

---

*Written 2026-04-24. Binding from this commit forward.*
