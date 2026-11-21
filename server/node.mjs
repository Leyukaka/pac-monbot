// Mode VM / serveur : exécute le même src/worker.js sous Node (>= 22.5), sans Cloudflare.
// SQLite local (node:sqlite) à la place de D1, fichiers de site/ servis en statique, collecte toutes les 5 min.
// Variables : MYUPLINK_CLIENT_ID, MYUPLINK_CLIENT_SECRET (obligatoires), SHOW_HOUSE, PORT (8787),
// HOST (127.0.0.1), DB_PATH (./data/pac.db), POLL_MINUTES (5).
// Pas d'authentification ici : à placer derrière un reverse proxy authentifié ou un tunnel (voir README).
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || join(ROOT, "data", "pac.db");
const POLL_MS = Math.max(1, Number(process.env.POLL_MINUTES || 5)) * 60_000;

for (const k of ["MYUPLINK_CLIENT_ID", "MYUPLINK_CLIENT_SECRET"]) {
  if (!process.env[k]) { console.error(`variable ${k} manquante`); process.exit(1); }
}

// ---------- base : SQLite avec une interface compatible D1 (prepare/bind/all/first/run, batch) ----------
mkdirSync(dirname(DB_PATH), { recursive: true });
const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
const migDir = join(ROOT, "migrations");
for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
  if (sqlite.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(f)) continue;
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(readFileSync(join(migDir, f), "utf8"));
    sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)").run(f);
    sqlite.exec("COMMIT");
    console.log("migration", f);
  } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
}

function stmt(sql, args = []) {
  return {
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { sqlite.prepare(sql).run(...args); return { success: true }; },
  };
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (list) => {
    sqlite.exec("BEGIN");
    try {
      const out = list.map((s) => ({ results: s.sql.trimStart().toUpperCase().startsWith("SELECT") ? sqlite.prepare(s.sql).all(...s.args) : (sqlite.prepare(s.sql).run(...s.args), []) }));
      sqlite.exec("COMMIT");
      return out;
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};

// ---------- cache mémoire (remplace caches.default, 60 s) ----------
const mem = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const e = mem.get(req.url);
      if (!e || e.exp < Date.now()) { mem.delete(req.url); return undefined; }
      return new Response(e.body, { status: e.status, headers: e.headers });
    },
    async put(req, res) {
      const age = Number((res.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 0);
      if (!age) return;
      if (mem.size > 500) mem.clear();
      mem.set(req.url, { body: await res.text(), status: res.status, headers: [...res.headers], exp: Date.now() + age * 1000 });
    },
  },
};

// ---------- fichiers statiques + en-têtes de site/_headers ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
const RULES = [];
if (existsSync(join(SITE, "_headers"))) {
  let cur = null;
  for (const line of readFileSync(join(SITE, "_headers"), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), h: [] }; RULES.push(cur); }
    else if (cur) { const i = line.indexOf(":"); cur.h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
  }
}
const ASSETS = {
  async fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    let file = normalize(join(SITE, p.endsWith("/") ? p + "index.html" : p));
    if (!file.startsWith(SITE + sep) || p.includes("_headers")) return new Response("introuvable", { status: 404 });
    if (!existsSync(file) || !statSync(file).isFile()) return new Response("introuvable", { status: 404 });
    const headers = new Headers({ "content-type": TYPES[extname(file)] || "application/octet-stream" });
    for (const r of RULES) if (r.re.test(p)) for (const [k, v] of r.h) headers.set(k, v);
    return new Response(req.method === "HEAD" ? null : readFileSync(file), { headers });
  },
};

const env = { ...process.env, DB, ASSETS };

// ---------- HTTP ----------
createServer(async (q, s) => {
  try {
    const req = new Request(`http://${q.headers.host || "localhost"}${q.url}`, { method: q.method, headers: q.headers });
    const res = await worker.fetch(req, env, { waitUntil: (p) => p.catch(() => {}) });
    s.writeHead(res.status, Object.fromEntries(res.headers));
    s.end(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.error(e);
    s.writeHead(500).end("erreur interne");
  }
}).listen(PORT, HOST, () => console.log(`pac : http://${HOST}:${PORT}`));

// ---------- collecte ----------
async function poll() {
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now(), cron: "node" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const last = sqlite.prepare("SELECT ok, n, detail FROM polls ORDER BY ts DESC LIMIT 1").get();
  console.log(new Date().toISOString(), "collecte", last?.ok ? `ok (${last.n} points)` : `échec : ${last?.detail}`);
}
poll();
setInterval(poll, POLL_MS);
