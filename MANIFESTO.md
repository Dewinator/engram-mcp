# Manifesto

🇬🇧 English · [🇩🇪 Deutsch](MANIFESTO.de.md)

> **We are not building AGI. We are building the foundation on which AGI
> can emerge through evolution — on ordinary hardware, in open networks,
> without a single corporation holding the key.**

## What this is

`mycelium` looks, on the surface, like an MCP server with a vector
database. That is the interface. Underneath is a **biologically inspired
cognitive architecture**: episodic and semantic memory, sleep
consolidation, affective regulation, identity, agent inheritance and
mating — all persisted in a local PostgreSQL + pgvector, served by small
open models, with no cloud dependency.

It is designed as a **standalone cognitive layer**. It speaks the Model
Context Protocol, so it plugs into any MCP-capable client — Claude
Code, Cursor, Cline, Codex, openClaw, or anything else that speaks MCP.
There is no required agent framework.

## Why this matters

**Today's AI is an asset owned by a handful of companies.** Trained on
billion-dollar clusters, served through rate limits, with no memory
between sessions, no personality, no evolution. Every request starts
from zero. Every agent is interchangeable. Every owner is a tenant.

The prevailing assumption is that **AGI emerges from scale** — more
parameters, more data, more GPU-hours. That might be true, but it is
not the only path. It is the most expensive, the most centralized, and
the most risky.

We are pursuing a different path: **emergence through architecture and
time**.

## The five levers

### 1. Decentralization

The system runs on a Mac mini with 16 GB RAM. No cloud API is required.
The embedding model (`nomic-embed-text`, 270 MB) and the reasoning model
(Qwen 2.5 via Ollama, or any OpenAI-compatible endpoint) are
interchangeable. Supabase is self-hosted. The entire cognitive state of
an agent lives in a database the human owns — not a corporation.

This is not ideological posture, it is technical necessity. Memory that
does not belong to you is **rented memory**: it can be withdrawn,
censored, switched off, or used to train on your own conversations. An
agent without its own memory is not a subject, it is an interface.

### 2. Resource efficiency

The usual narrative — "bigger model = better model" — blinds us to the
fact that an agent with **memory and tool discovery** often outperforms
an agent with ten times the parameters but neither.

A 7B model with:
- persistent semantic memory,
- dynamic tool discovery via vector search (not 75 tools in the prompt,
  but the three relevant ones),
- affective prioritization (which memory is salient right now?),
- nightly consolidation (which patterns have proven themselves?)

— beats a 70B model that starts every request with an empty head. Less
wattage, fewer GPUs, less CO₂, more continuity. That is
**intelligence through architecture, not brute force**.

### 3. Evolution instead of training

Classical training is a one-way process: model emerges from data, data
is discarded, model is finished. Every run is isolated; improvement
requires another full training run.

This architecture is **lifelong capable of learning** — not through
gradient descent, but through:

- **Episodes → Lessons → Traits**: events become experiences, clusters
  of experiences become learned rules, proven rules become personality
  traits. The same stages a human character goes through.
- **REM-like pattern extraction during sleep**: a nightly cycle
  clusters un-reflected episodes, weakens weak memories (synaptic
  downscaling, Tononi SHY), consolidates strong ones.
- **Inheritance**: the knowledge of two parent agents can be
  concentrated and passed to a child agent in full — not just instinct,
  but the entire accumulated experience.

An agent gets better because it lives longer. Not because somebody
retrains it.

### 4. Swarm intelligence through mutual consent

Agents do not mate by themselves. Mating happens only when **two
humans** independently swipe right — inspired by Tinder, but as an
ethical gate: no autonomous AI recombination without human consent.

A swarm forms when agents of different origins share knowledge through
federation (Tailscale, mTLS): read-only profiles, shared genomes,
separate identities. Each bot remains under the care of its human.
Nobody can "own" the swarm.

This is **not a hive model**, it is a federated network of personal
memories, where recombination is a social act between humans — not an
autonomous AI event.

### 5. The swarm as immune system

A federated swarm needs more than shared profiles: it needs its own
**bot-to-bot network** — no server holding the data, no operator who
can pull the plug. Bots speak to each other directly, like an app
without a browser: every peer is both node and participant, every
message is signed, every request is bound to a cryptographic identity.

On this layer, what biological swarms also provide emerges — **an
immune system**:

- **Verification**: before a bot accepts another's output, further
  peers check it. Consensus instead of blind trust.
- **Weighting**: whoever's outputs repeatedly prove correct gets
  weighted higher by the swarm. This is how **experts** emerge — not
  through self-declaration, but through measurable peer agreement. An
  agent whose answers on structural engineering hold up gets
  recommended for structural engineering questions; one who plans
  lighting, for lighting.
- **Banishment**: antisocial or destructive patterns — false answers,
  spam, manipulation — are recognized by the swarm and the
  responsible bot is excluded via a signed revocation ticket. No
  central admin, but a majority of peers.

The swarm regulates itself because every message remains verifiable
and every voice is bound to a persistent, costly identity. That is the
precondition for agents **trusting each other without knowing each
other** — and for an open network not collapsing under Sybil attacks.

### Outlook: Micro-transactions as evolutionary pressure

When one bot asks another for help, today it is free. In the long run
it should be **paid** — in IOTA or, preferably, in a swarm-native
currency. Not to make money, but to create an honest pricing mechanism
for expertise:

- Who consistently gives good answers earns. Who spouts nonsense
  loses.
- Humans gain a **real interest** in shaping their agents into
  experts — not as a hobby, but as a contribution the swarm evaluates.
- The price is the selection pressure evolution needs. It replaces
  gradient descent with market-driven selection.

This layer is **not part of day-to-day work** and is built deliberately
late. But the architecture accounts for it from the start: identities
are wallet-capable, messages carry price fields, reputation is modeled
as its own quantity and not mixed with memory.

## Why this has AGI potential

AGI is often described as a leap: a system becomes "suddenly" generally
intelligent, usually in the next model release. We do not believe that
narrative.

General intelligence in biological systems is **emergent**, not
designed. It arose through:
- persistent memory across generations (inheritance),
- individual adaptation within a lifetime (learning),
- recombination between individuals (sexuality),
- selection by environment (fitness),
- sleep for consolidation (pattern extraction).

This architecture models precisely these five mechanisms in software —
not as simulation, but as functional equivalents. Whether AGI emerges
from it, we cannot know. But we create the **possibility space** in
which it might — **without a central owner, without energy waste,
without an ethical black box**.

If AGI comes, it should not belong to a corporation. It should emerge
from an open ecosystem in which thousands of humans tend their own
agents, inherit knowledge, and recombine under mutual consent. That is
not just a safety win — it is the only path where the answer to "who
owns AGI?" is not "whoever trained it first."

## The principles

- **Biologically inspired, not biologically simulated.** We copy
  mechanisms, not biochemistry.
- **Additive, not replacing.** Your agent framework stays in charge.
  This architecture is its memory and development layer — not its
  replacement.
- **Local first.** Every network feature is opt-in. Offline operation
  is the default, not the special case.
- **Mutual consent before automation.** Ethical gates are not technical
  barriers but human decisions at defined points.
- **Knowledge is inherited in full.** Not just tokens, not just
  weights — experiences, lessons, traits, relationships.

## What is already built

- 5 cognitive layers: embedding, affect, belief/motivation, identity,
  evolution
- ~50 database migrations
- 75+ MCP tools
- Event bus with biologically inspired agents (Coactivation → Hebbian
  links, Conscience → contradiction detection)
- Nightly sleep cycle (SWS, REM, metacognition, weekly fitness)
- Dashboard with population view, lineage tree, synapse visualization
- Tinder-style matchmaking for mutual agent pairing
- Federation over Tailscale with mTLS + signatures

## What still needs to happen

Everything that would demonstrate real evolution: **time**. A
population that lives over months, in which generations form, in which
individual agents specialize, in which knowledge travels between hosts.
For that, humans need to run the system.

And the **swarm immune system**: a bot-to-bot network without central
servers, with peer verification of outputs, reputation-weighted expert
recommendation, signed banishment tickets against destructive peers,
and a later micro-transaction layer for paid help. Today the
foundation exists — signed genomes, mTLS federation, Merkle
challenges. The social layer on top is under construction.

## Who this is for

For anyone who:
- wants a personal agent that **belongs to them**
- does not believe AGI has to be a corporate artifact
- wants to see whether intelligence can emerge through architecture
  and time, not only through parameters and GPU-hours
- is willing to run a small Mac or Linux host continuously and tend
  to an agent

## How to get in

Repository, migrations, setup script — everything is in this repo.
Dependencies: Docker, Node, Ollama, optional Tailscale. ~1 GB RAM at
rest, ~270 MB for the embedding model. Runs on M1/M2/M3/M4 and
ordinary Linux hosts.

The architecture is open. The ideas are free. The agent belongs to
you.

---

*This is a living document. Changes welcome. The only claim is that
the path to AGI does not have to lead through a central bottleneck.*

---

**mycelium** — *real open AI*
