#!/usr/bin/env node
/**
 * consolidate-by-patterns.mjs — Pattern-basierte Konsolidierung.
 *
 * Liest Tag-Ko-Vorkommen aus memory_patterns (Migration 049), filtert auf
 * starke Muster (Lift >= minLift) und erzeugt paarweise `related`-Edges
 * zwischen Memories, die beide Tags tragen. Idempotent — chain_memories
 * verstaerkt existierende Edges.
 *
 * Nutzung:
 *   — als CLI:        node scripts/consolidate-by-patterns.mjs [--dry]
 *   — als Modul:      import { consolidateByPatterns } from "./consolidate-by-patterns.mjs"
 *                     (wird aus nightly-sleep.mjs SWS-Phase aufgerufen)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, "..");

const DEFAULTS = {
  minLift:      5,
  minSupport:   0.01,
  maxPerPair:   15,
  patternLimit: 100,
  blocklist:    ["functions", "tool", "vector-memory", "mcp"],
  dryRun:       false,
};

export async function consolidateByPatterns(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const SUPABASE_URL = opts.supabaseUrl ?? process.env.SUPABASE_URL;
  const SUPABASE_KEY = opts.supabaseKey ?? process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL/KEY missing");

  const REST = {
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "apikey":        SUPABASE_KEY,
  };
  const blocked = new Set(cfg.blocklist);

  async function rpc(name, body) {
    const r = await fetch(`${SUPABASE_URL}/rpc/${name}`, {
      method: "POST", headers: REST, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`rpc ${name} HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async function memsWithBothTags(a, b, limit) {
    const url = new URL(`${SUPABASE_URL}/memories`);
    url.searchParams.set("select", "id,strength");
    url.searchParams.set("tags",   `cs.{${a},${b}}`);
    url.searchParams.set("valid_until", "is.null");
    url.searchParams.set("order",  "strength.desc");
    url.searchParams.set("limit",  String(limit));
    const r = await fetch(url, { headers: REST });
    if (!r.ok) throw new Error(`memories HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  }

  const weight = (lift) => Math.min(0.3 + lift / 30, 0.85);

  const pResp = await rpc("memory_patterns", {
    p_limit:       cfg.patternLimit,
    p_min_support: cfg.minSupport,
    p_project_id:  null,
  });
  const patterns = Array.isArray(pResp) ? pResp : (pResp.patterns || []);

  const eligible = patterns.filter(p =>
    p.lift >= cfg.minLift &&
    !blocked.has(p.tag_a) &&
    !blocked.has(p.tag_b)
  );

  const result = {
    total_memories:    pResp.total_memories ?? null,
    patterns_total:    patterns.length,
    patterns_eligible: eligible.length,
    pairs_processed:   0,
    edges_created:     0,
    skipped:           0,
    dry_run:           !!cfg.dryRun,
    details:           [],
    errors:            [],
  };

  for (const p of eligible) {
    let mems;
    try { mems = await memsWithBothTags(p.tag_a, p.tag_b, cfg.maxPerPair); }
    catch (e) { result.errors.push({ pair: `${p.tag_a}×${p.tag_b}`, msg: String(e?.message ?? e) }); continue; }

    if (mems.length < 2) { result.skipped++; continue; }

    const w = weight(p.lift);
    const reason = `auto-consolidated: ${p.tag_a} × ${p.tag_b} (lift=${p.lift.toFixed(2)}, n=${p.n_ab})`;
    const pairCount = (mems.length * (mems.length - 1)) / 2;

    result.details.push({
      tag_a: p.tag_a, tag_b: p.tag_b,
      lift:  p.lift,  n: p.n_ab,
      memories: mems.length, edges: pairCount, weight: w,
    });
    result.pairs_processed += 1;

    if (cfg.dryRun) { result.edges_created += pairCount; continue; }

    for (let i = 0; i < mems.length; i++) {
      for (let j = i + 1; j < mems.length; j++) {
        try {
          await rpc("chain_memories", {
            p_a_id:     mems[i].id,
            p_b_id:     mems[j].id,
            p_type:     "related",
            p_reason:   reason,
            p_weight:   w,
            p_agent_id: null,
          });
          result.edges_created++;
        } catch (e) {
          result.errors.push({ pair: `${p.tag_a}×${p.tag_b}`, a: mems[i].id, b: mems[j].id, msg: String(e?.message ?? e) });
        }
      }
    }
  }

  return result;
}

// ---- CLI ---------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const mcpCfg = JSON.parse(await fs.readFile(path.join(ROOT, ".mcp.json"), "utf8"));
  const env = mcpCfg.mcpServers["vector-memory"].env;

  const res = await consolidateByPatterns({
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_KEY,
    dryRun:      process.argv.includes("--dry"),
  });

  console.log(`[consolidate] total_memories=${res.total_memories}, patterns total=${res.patterns_total}, eligible=${res.patterns_eligible}`);
  for (const d of res.details) {
    console.log(`  ${d.tag_a} × ${d.tag_b}: ${d.memories} memories → ${d.edges} edges, weight=${d.weight.toFixed(2)}`);
  }
  console.log(`[consolidate] done: pairs=${res.pairs_processed}, edges=${res.edges_created}, skipped=${res.skipped}, errors=${res.errors.length}${res.dry_run ? " (DRY RUN)" : ""}`);
  if (res.errors.length) console.error(JSON.stringify(res.errors.slice(0, 5), null, 2));
}
