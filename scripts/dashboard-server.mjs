#!/usr/bin/env node
// vectormemory dashboard — tiny HTTP host + PostgREST proxy.
//
// Why this exists:
//  - The dashboard HTML must be reachable from your phone over Tailscale,
//    not just localhost.
//  - PostgREST stays bound to 127.0.0.1 inside docker (security).
//  - The service_role JWT must not live in the browser. This proxy keeps it
//    server-side and injects it into the upstream call.
//
// Usage:
//   node scripts/dashboard-server.mjs            # binds 0.0.0.0:8787
//   PORT=9000 HOST=100.x.y.z node scripts/...    # custom bind
//
// Open from your phone (Tailscale connected to the same tailnet):
//   http://<mac-name>.<tailnet>.ts.net:8787/
// or http://<tailscale-ipv4>:8787/

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const DASH_DIR   = path.join(ROOT, "dashboard");
const ENV_FILE   = path.join(ROOT, "docker", ".env");

// --- load JWT_SECRET from docker/.env so we can mint a service_role JWT ---
async function loadEnv() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

// Minimal HS256 JWT signer using built-in crypto.
import crypto from "node:crypto";
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

const env  = await loadEnv();
const JWT_SECRET = process.env.JWT_SECRET || env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET not set (looked in docker/.env and process env).");
  process.exit(1);
}
const SERVICE_JWT = signJwt(
  { role: "service_role", iss: "vectormemory-dashboard", iat: Math.floor(Date.now() / 1000) },
  JWT_SECRET
);

const UPSTREAM = process.env.POSTGREST_URL || "http://127.0.0.1:54321";
const PORT     = Number(process.env.PORT || 8787);
const HOST     = process.env.HOST || "0.0.0.0";

// --- static file serving (just the dashboard dir) ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(DASH_DIR, rel);
  // Path traversal guard.
  if (!filePath.startsWith(DASH_DIR)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

// --- proxy /api/* → PostgREST, injecting the service_role JWT ---
async function proxyApi(req, res) {
  const upstreamPath = req.url.replace(/^\/api/, "") || "/";
  const upstreamUrl  = new URL(upstreamPath, UPSTREAM);

  // Buffer request body (POST/PATCH).
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // Forward only the headers PostgREST cares about; strip auth from client.
  const fwdHeaders = {
    "Content-Type": req.headers["content-type"] || "application/json",
    "Authorization": `Bearer ${SERVICE_JWT}`,
    "apikey": SERVICE_JWT,
  };
  const accept = req.headers["accept"];
  if (accept) fwdHeaders["Accept"] = accept;
  const prefer = req.headers["prefer"];
  if (prefer) fwdHeaders["Prefer"] = prefer;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unreachable", detail: String(e?.message || e) }));
  }
}

const server = http.createServer((req, res) => {
  // Tiny access log.
  const t = new Date().toISOString();
  res.on("finish", () => console.log(`${t} ${req.socket.remoteAddress} ${req.method} ${req.url} -> ${res.statusCode}`));

  if (req.url.startsWith("/api/")) return proxyApi(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end("method not allowed"); return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`vectormemory dashboard listening on http://${HOST}:${PORT}`);
  console.log(`upstream PostgREST: ${UPSTREAM}`);
  console.log(`open from your phone over Tailscale and head to port ${PORT}`);
});
