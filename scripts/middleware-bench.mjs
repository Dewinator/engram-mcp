#!/usr/bin/env node
/**
 * Mycelium middleware benchmark — issue #5 (N5 of the small-model epic).
 *
 * Measures three latency profiles for one or more local models:
 *
 *   1. baseline    — direct POST to Ollama /api/chat. No injection, no
 *                    cache. Establishes the bare-model cost.
 *   2. middleware-cold — POST through the proxy with cache cold. Shows
 *                    the cost of injection + Supabase RPCs + embed.
 *   3. middleware-warm — second consecutive POST through the proxy.
 *                    Cache hit; demonstrates N7's payoff.
 *
 * Output: a markdown report with one table per model, written to
 * docs/benchmarks/<UTC-DATE>.md (created on first run). Prints the same
 * report to stdout for the CI / reviewer.
 *
 * Usage:
 *   OLLAMA_URL=http://127.0.0.1:11434 \
 *   PROXY_URL=http://127.0.0.1:18794 \
 *   MODELS=qwen2.5:7b-instruct,qwen3-fast:8b-8k \
 *   node scripts/middleware-bench.mjs
 *
 * The script does NOT spin up the proxy itself — start it before running:
 *
 *   SUPABASE_URL=… SUPABASE_KEY=… \
 *   node mcp-server/dist/middleware/proxy.js &
 *
 * The middleware test prompt is short (num_predict=8) so the benchmark
 * isn't dominated by token-generation time. We measure prefill + first-
 * token latency: that's the cost the user actually feels.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const PROXY_URL  = process.env.PROXY_URL  ?? "http://127.0.0.1:18794";
const MODELS     = (process.env.MODELS ?? "qwen2.5:7b-instruct").split(",").map((s) => s.trim()).filter(Boolean);
const PROMPT     = process.env.BENCH_PROMPT ?? "Was sind meine offenen Intentionen? Bitte sehr kurz.";
const NUM_PREDICT = Number(process.env.BENCH_NUM_PREDICT ?? 8);
const RUNS       = Number(process.env.BENCH_RUNS ?? 1);

async function postChat(url, model) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${url}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT }],
      stream:   false,
      options:  { num_predict: NUM_PREDICT },
    }),
  });
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1_000_000;
  const headers = Object.fromEntries(res.headers.entries());
  let body = null;
  try { body = await res.json(); } catch { /* swallow */ }
  return { ok: res.ok, status: res.status, ms, headers, prompt_eval_count: body?.prompt_eval_count ?? null };
}

async function preflight() {
  // Fail fast with a useful message instead of N opaque ECONNREFUSED.
  const checks = await Promise.all([
    fetch(`${OLLAMA_URL}/api/version`).then((r) => r.ok).catch(() => false),
    fetch(`${PROXY_URL}/health`).then((r) => r.ok).catch(() => false),
  ]);
  if (!checks[0]) {
    console.error(`Ollama not reachable at ${OLLAMA_URL} — start it first.`);
    process.exit(1);
  }
  if (!checks[1]) {
    console.error(`Mycelium middleware not reachable at ${PROXY_URL} — start it first:`);
    console.error(`  SUPABASE_URL=… SUPABASE_KEY=… node mcp-server/dist/middleware/proxy.js &`);
    process.exit(1);
  }
}

async function clearProxyCache() {
  // No public endpoint clears the cache (by design — operators don't usually
  // want to wipe it). For the benchmark we settle for restarting the
  // measurement on a different cache key by changing the prompt. Cheaper
  // than a forced restart.
  // The "cold" run is approximated by changing the prompt every iteration
  // so the cache key shifts. Proper cold timings need a fresh proxy boot —
  // reviewers can do that manually if absolute precision is needed.
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return `${Math.round(ms)} ms`;
}

async function benchOne(model) {
  console.error(`\n=== ${model} ===`);
  const rows = [];

  // baseline (direct → Ollama)
  for (let i = 0; i < RUNS; i++) {
    const r = await postChat(OLLAMA_URL, model);
    rows.push({ profile: "baseline (direct)", run: i + 1, ms: r.ms, status: r.status, prompt_tokens: r.prompt_eval_count, cache: "—", injected: "0" });
    console.error(`  baseline   #${i + 1}: ${fmtMs(r.ms)} status=${r.status} prompt_tokens=${r.prompt_eval_count}`);
  }

  // middleware cold — different prompt per run to bypass cache
  for (let i = 0; i < RUNS; i++) {
    process.env.BENCH_PROMPT_COLD = `${PROMPT} cold-${Date.now()}-${i}`;
    const coldUrl  = `${PROXY_URL}/api/chat`;
    const t0 = process.hrtime.bigint();
    const res = await fetch(coldUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: process.env.BENCH_PROMPT_COLD }],
        stream:   false,
        options:  { num_predict: NUM_PREDICT },
      }),
    });
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1_000_000;
    const cache = res.headers.get("x-mycelium-cache") ?? "—";
    const injected = res.headers.get("x-mycelium-injected") ?? "0";
    let body = null; try { body = await res.json(); } catch {}
    rows.push({ profile: "middleware cold", run: i + 1, ms, status: res.status, prompt_tokens: body?.prompt_eval_count ?? null, cache, injected });
    console.error(`  proxy cold #${i + 1}: ${fmtMs(ms)} status=${res.status} cache=${cache} injected=${injected} prompt_tokens=${body?.prompt_eval_count ?? "?"}`);
  }

  // middleware warm — same prompt twice in a row, second one hits cache
  await postChat(PROXY_URL, model);  // prime the cache for the warm prompt
  for (let i = 0; i < RUNS; i++) {
    const r = await postChat(PROXY_URL, model);
    rows.push({ profile: "middleware warm", run: i + 1, ms: r.ms, status: r.status, prompt_tokens: r.prompt_eval_count, cache: r.headers["x-mycelium-cache"] ?? "—", injected: r.headers["x-mycelium-injected"] ?? "0" });
    console.error(`  proxy warm #${i + 1}: ${fmtMs(r.ms)} status=${r.status} cache=${r.headers["x-mycelium-cache"]} prompt_tokens=${r.prompt_eval_count}`);
  }

  return rows;
}

function renderMarkdown(byModel) {
  const date = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";
  const lines = [];
  lines.push(`# Middleware benchmark — ${date}`);
  lines.push("");
  lines.push(`Prompt: \`${PROMPT}\` · num_predict=${NUM_PREDICT} · runs/profile=${RUNS}`);
  lines.push("");
  lines.push(`Stack: Ollama \`${OLLAMA_URL}\` · Mycelium proxy \`${PROXY_URL}\``);
  lines.push("");
  for (const [model, rows] of byModel) {
    lines.push(`## ${model}`);
    lines.push("");
    lines.push("| profile | run | latency | status | prompt tokens | cache | injected |");
    lines.push("|---|---:|---:|---:|---:|---|---:|");
    for (const r of rows) {
      lines.push(`| ${r.profile} | ${r.run} | ${fmtMs(r.ms)} | ${r.status} | ${r.prompt_tokens ?? "—"} | ${r.cache} | ${r.injected} |`);
    }
    lines.push("");
    // headline numbers
    const baseline = rows.filter((r) => r.profile.startsWith("baseline")).map((r) => r.ms);
    const cold     = rows.filter((r) => r.profile === "middleware cold").map((r) => r.ms);
    const warm     = rows.filter((r) => r.profile === "middleware warm").map((r) => r.ms);
    const avg = (a) => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null;
    const overhead_cold = avg(cold)     != null && avg(baseline) != null ? avg(cold) - avg(baseline) : null;
    const overhead_warm = avg(warm)     != null && avg(baseline) != null ? avg(warm) - avg(baseline) : null;
    lines.push(`**Headline:** baseline ≈ ${avg(baseline)} ms · cold-proxy adds ${overhead_cold ?? "?"} ms · warm-proxy adds ${overhead_warm ?? "?"} ms`);
    lines.push("");
  }
  return lines.join("\n");
}

(async function main() {
  await preflight();
  const byModel = [];
  for (const model of MODELS) {
    const rows = await benchOne(model);
    byModel.push([model, rows]);
  }
  const md = renderMarkdown(byModel);
  console.log("\n" + md);

  // Write report
  const dir = join(REPO_ROOT, "docs", "benchmarks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = join(dir, new Date().toISOString().slice(0, 10) + ".md");
  writeFileSync(filename, md);
  console.error(`\n→ report saved: ${filename}`);
})().catch((e) => { console.error(e); process.exit(1); });
