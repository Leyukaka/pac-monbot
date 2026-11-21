// pac : collecte myUplink (cron) + API JSON + site statique.
// Secrets : MYUPLINK_CLIENT_ID, MYUPLINK_CLIENT_SECRET (wrangler secret put). Lecture seule (READSYSTEM).
// Variable : SHOW_HOUSE = "1" pour publier les intensités des phases maison (à n'activer que derrière une authentification).

const API = "https://api.myuplink.com";

// Points historisés à chaque collecte (IDs vérifiés sur la VVM 500 le 2026-11-21).
// La liste complète des 574 points reste dans la table `points` (consultable via wrangler d1, pas publiée).
export const TRACKED = [
  "40004", "40067",                  // BT1 extérieur, moyenne
  "40008", "40012", "43009",         // départ BT2, retour BT3, départ calculé
  "40013", "40014", "40121",         // ECS haut BT7, ECS charge BT6, appoint BT63
  "40940",                           // degrés-minutes (43005 absent sur ce firmware)
  "43081", "43084",                  // facteur temps appoint, puissance appoint
  "43437", "44396",                  // pompes GP1, GP12
  "40079", "40081", "40083",         // intensités BE3, BE2, BE1 (phases maison, privé)
  "44701", "40782", "44064", "44703",// EB101 fréquence, demandée, état, dégivrage
  "44069", "44071", "44073",         // EB101 démarrages, heures, heures ECS
  "44059", "44060", "44061", "44363", "44058", "44055", "44362", // BT14 BT15 BT17 BT16 BT12 BT3 BT28
  "41163", "41162",                  // BP9, BP8 (température de saturation, °C)
  "41025", "41019",                  // EVI position, surchauffe EVI
  // Journal d'énergie NIBE : puissance instantanée + bilans heure passée.
  "32486",                           // puissance électrique actuelle (kW)
  "32491", "32492",                  // produit chauffage / ECS, heure passée (kWh)
  "32495", "32496",                  // consommé chauffage / ECS, heure passée (kWh)
  "32499", "32500",                  // consommé par l'appoint chauffage / ECS, heure passée (kWh)
  "50321", "50322",                  // consommation / production sur 1 an (kWh)
];
// Révèlent la présence dans la maison : jamais publiés sans SHOW_HOUSE=1.
const HOUSE = new Set(["40079", "40081", "40083"]);

// [durée, pas d'agrégation] ; "30dd" = 30 jours par jour civil UTC (bande thermique, bilan).
const RANGES = { "24h": [86400, 600], "7d": [7 * 86400, 3600], "30d": [30 * 86400, 6 * 3600], "30dd": [30 * 86400, 86400], "365d": [365 * 86400, 86400] };
// Fenêtre libre : ~400 points max par courbe. À partir d'une heure, lecture dans readings_h.
const STEPS = [300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 7 * 86400];
const MAX_SPAN = 3 * 365 * 86400;
const CACHE_S = 60;

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method !== "GET") return json({ error: "méthode non autorisée" }, 405);

    // Limitation de débit par IP (binding Workers Rate Limiting).
    if (env.RL) {
      const ip = req.headers.get("cf-connecting-ip") || "?";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "trop de requêtes, réessayez dans une minute" }, 429);
    }

    const route = { "/api/now": now, "/api/series": series, "/api/health": health }[url.pathname];
    if (!route) return json({ error: "inconnu" }, 404);

    // Cache 60 s sur une clé normalisée (fenêtres arrondies), pour absorber les rafraîchissements.
    const key = new Request(cacheKey(url).toString());
    const cache = caches.default;
    // Le cache de la zone réécrit max-age (Browser Cache TTL 4 h) : le navigateur reçoit toujours
    // no-store, seule la copie mise dans caches.default porte max-age=60.
    const toClient = (r) => { const out = new Response(r.body, r); out.headers.set("cache-control", "no-store"); return out; };
    const hit = await cache.match(key);
    if (hit) return toClient(hit);
    let res;
    try {
      res = json(await route(env, url.searchParams), 200, CACHE_S);
    } catch (e) {
      console.error("api", url.pathname, e && e.stack || e);
      return json({ error: "erreur interne" }, 500);
    }
    ctx.waitUntil(cache.put(key, res.clone()));
    return toClient(res);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env).catch(async (e) => {
      console.error("collect", e && e.stack || e);
      await env.DB.prepare("INSERT OR REPLACE INTO polls (ts, ok, n, detail) VALUES (?, 0, 0, ?)")
        .bind(nowS(), String(e && e.message || e).slice(0, 500)).run();
    }));
  },
};

function cacheKey(url) {
  const k = new URL(url.origin + url.pathname);
  const q = url.searchParams;
  for (const name of ["range", "pids"]) if (q.has(name)) k.searchParams.set(name, q.get(name));
  const from = Number(q.get("from")), to = Number(q.get("to"));
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    const g = Math.max(60, pickStep(to - from)); // arrondi au pas : même clé pour des fenêtres voisines
    k.searchParams.set("from", String(Math.floor(from / g) * g));
    k.searchParams.set("to", String(Math.ceil(to / g) * g));
  }
  return k;
}

// ---------- collecte ----------

async function collect(env) {
  const ts = nowS();
  if ((await kvGet(env, "backoff_until", 0)) > ts) return; // quota myUplink dépassé : on attend

  const token = await getToken(env);
  const ids = await getIds(env, token);
  const pts = await api(env, token, `/v2/devices/${ids.deviceId}/points`);
  const stmts = [];
  const tracked = new Set(TRACKED);
  const refreshMeta = (await kvGet(env, "meta_ts", 0)) < ts - 3600;

  for (const p of pts) {
    const pid = String(p.parameterId);
    const v = typeof p.value === "number" ? p.value : Number(p.value);
    if (tracked.has(pid) && Number.isFinite(v)) {
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO readings (ts, pid, value) VALUES (?, ?, ?)").bind(ts, pid, v));
    }
    if (tracked.has(pid) || refreshMeta) {
      stmts.push(env.DB.prepare(
        "INSERT INTO points (pid, name, unit, category, device, last_ts, last_val, last_str) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(pid) DO UPDATE SET name=excluded.name, unit=excluded.unit, category=excluded.category, device=excluded.device, " +
        "last_ts=excluded.last_ts, last_val=excluded.last_val, last_str=excluded.last_str"
      ).bind(pid, String(p.parameterName || pid).replace(/­/g, ""), p.parameterUnit || null, p.category || null, ids.deviceId,
        p.timestamp ? Math.floor(Date.parse(p.timestamp) / 1000) : ts, Number.isFinite(v) ? v : null, p.strVal ?? null));
    }
  }
  if (refreshMeta) stmts.push(kvPut(env, "meta_ts", ts));

  // Agrégat de l'heure en cours (recalculé à chaque collecte, ~12 lignes lues par point).
  const h = Math.floor(ts / 3600) * 3600;
  stmts.push(env.DB.prepare(
    "INSERT INTO readings_h (ts, pid, a, lo, hi, n) SELECT ?, pid, AVG(value), MIN(value), MAX(value), COUNT(*) FROM readings " +
    "WHERE ts >= ? AND ts < ? GROUP BY pid ON CONFLICT(ts, pid) DO UPDATE SET a=excluded.a, lo=excluded.lo, hi=excluded.hi, n=excluded.n"
  ).bind(h, h, h + 3600));

  // Alarmes : toutes les 15 min.
  if ((await kvGet(env, "alarm_ts", 0)) < ts - 900) {
    const al = await api(env, token, `/v2/systems/${ids.systemId}/notifications/active?page=1&itemsPerPage=20`).catch(() => null);
    if (al) stmts.push(kvPut(env, "alarms", JSON.stringify((al.notifications || al.items || []).map(pickAlarm))), kvPut(env, "alarm_ts", ts));
  }

  // Test unique : la route d'historique myUplink est-elle accessible sans Premium ?
  if (!(await kvGet(env, "hist_probe", null))) {
    const to = new Date(ts * 1000), from = new Date((ts - 2 * 86400) * 1000);
    const r = await fetch(`${API}/v2/devices/${ids.deviceId}/points/40004/${from.toISOString()}/${to.toISOString()}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).catch(() => null);
    let n = null;
    if (r && r.ok) { const j = await r.json().catch(() => null); n = Array.isArray(j) ? j.length : (j && (j.items || j.points || j.values || []).length) ?? null; }
    stmts.push(kvPut(env, "hist_probe", JSON.stringify({ ts, status: r ? r.status : "réseau", n })));
  }

  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO polls (ts, ok, n, detail) VALUES (?, 1, ?, NULL)").bind(ts, pts.length));
  await env.DB.batch(stmts);
}

function pickAlarm(a) {
  return { alarmNumber: a.alarmNumber ?? null, severity: a.severity ?? null, header: a.header ?? null, createdDatetime: a.createdDatetime ?? null };
}

async function getToken(env) {
  const cached = await kvGet(env, "token", null);
  const exp = await kvGet(env, "token_exp", 0);
  if (cached && exp > nowS() + 60) return cached;
  const body = new URLSearchParams({
    grant_type: "client_credentials", scope: "READSYSTEM",
    client_id: (env.MYUPLINK_CLIENT_ID || "").trim(), client_secret: (env.MYUPLINK_CLIENT_SECRET || "").trim(),
  });
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  await checkRate(env, r);
  if (!r.ok) throw new Error(`token ${r.status}`);
  const t = await r.json();
  await env.DB.batch([kvPut(env, "token", t.access_token), kvPut(env, "token_exp", nowS() + (t.expires_in || 3600))]);
  return t.access_token;
}

async function getIds(env, token) {
  const c = await kvGet(env, "ids", null);
  const at = await kvGet(env, "ids_ts", 0);
  if (c && at > nowS() - 86400) return JSON.parse(c);
  const me = await api(env, token, "/v2/systems/me?page=1&itemsPerPage=10");
  const sys = (me.systems || [])[0];
  if (!sys || !sys.devices || !sys.devices[0]) throw new Error("aucun système myUplink");
  const ids = { systemId: sys.systemId, deviceId: sys.devices[0].id, name: sys.name, product: sys.devices[0].product?.name || null };
  await env.DB.batch([kvPut(env, "ids", JSON.stringify(ids)), kvPut(env, "ids_ts", nowS())]);
  return ids;
}

async function api(env, token, path, retried = false) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, "Accept-Language": "fr-FR", Accept: "application/json" } });
  await checkRate(env, r);
  if (r.status === 401 && !retried) {
    await kvPut(env, "token_exp", 0).run();
    return api(env, await getToken(env), path, true);
  }
  if (!r.ok) throw new Error(`${path.split("?")[0].replace(/[0-9a-f-]{20,}/gi, "…")} ${r.status}`);
  return r.json();
}

// 429 : on respecte RateLimit-Reset (secondes) avant la collecte suivante.
async function checkRate(env, r) {
  if (r.status !== 429) return;
  const reset = Number(r.headers.get("ratelimit-reset") || r.headers.get("retry-after") || 300);
  await kvPut(env, "backoff_until", nowS() + Math.min(3600, Math.max(60, reset))).run();
  throw new Error("myUplink 429, pause " + reset + " s");
}

// ---------- lecture ----------

async function now(env) {
  const pub = TRACKED.filter((p) => env.SHOW_HOUSE === "1" || !HOUSE.has(p));
  const rows = (await env.DB.prepare("SELECT pid, unit, last_ts, last_val FROM points WHERE pid IN (" +
    pub.map(() => "?").join(",") + ")").bind(...pub).all()).results;
  const last = await env.DB.prepare("SELECT ts, ok FROM polls ORDER BY ts DESC LIMIT 1").first();
  const lastOk = await env.DB.prepare("SELECT ts FROM polls WHERE ok = 1 ORDER BY ts DESC LIMIT 1").first();
  // Compteurs d'il y a 7 jours (une ligne par point, via l'index pid/ts).
  const ago = nowS() - 7 * 86400;
  const old = (await env.DB.prepare(
    "SELECT r.pid, r.value, r.ts FROM readings r JOIN (SELECT pid, MIN(ts) AS t FROM readings WHERE pid IN ('44069','44071','44073','43081') AND ts >= ? GROUP BY pid) m ON r.pid = m.pid AND r.ts = m.t"
  ).bind(ago).all()).results;
  const alarms = JSON.parse(await kvGet(env, "alarms", "[]")).map((a) => ({ severity: a.severity ?? null, header: a.header ?? null }));
  return {
    points: Object.fromEntries(rows.map((r) => [r.pid, r])),
    counters7d: Object.fromEntries(old.map((r) => [r.pid, { value: r.value, ts: r.ts }])),
    alarms,
    house: env.SHOW_HOUSE === "1",
    poll: { last: last ? { ts: last.ts, ok: last.ok } : null, lastOk: lastOk?.ts ?? null },
    server: nowS(),
  };
}

function pickStep(span) { return STEPS.find((s) => span / s <= 400) || STEPS[STEPS.length - 1]; }

async function series(env, q) {
  let [span, step] = RANGES[q.get("range")] || RANGES["24h"];
  let since = nowS() - span, until = nowS() + 60;
  const from = Number(q.get("from")), to = Number(q.get("to"));
  if (q.get("range") === "all") {
    const f = await env.DB.prepare("SELECT MIN(ts) AS t FROM readings_h").first();
    since = f?.t ?? nowS() - 86400; span = until - since; step = pickStep(span);
  } else if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    since = Math.floor(from); until = Math.ceil(to); span = until - since; step = pickStep(span);
  }
  if (span > MAX_SPAN) { since = until - MAX_SPAN; step = pickStep(MAX_SPAN); }
  const pids = [...new Set((q.get("pids") || "").split(","))]
    .filter((p) => TRACKED.includes(p) && (env.SHOW_HOUSE === "1" || !HOUSE.has(p))).slice(0, 12);
  if (!pids.length) return {};
  const ph = pids.map(() => "?").join(",");
  // Pas >= 1 h : table horaire (au plus ~24 lignes/jour/point) au lieu des relevés bruts.
  const sql = step >= 3600
    ? `SELECT pid, (ts / ?) * ? AS b, SUM(a * n) / SUM(n) AS a, MIN(lo) AS lo, MAX(hi) AS hi FROM readings_h
       WHERE ts >= ? AND ts <= ? AND pid IN (${ph}) GROUP BY pid, b ORDER BY b`
    : `SELECT pid, (ts / ?) * ? AS b, AVG(value) AS a, MIN(value) AS lo, MAX(value) AS hi FROM readings
       WHERE ts >= ? AND ts <= ? AND pid IN (${ph}) GROUP BY pid, b ORDER BY b`;
  const rows = (await env.DB.prepare(sql).bind(step, step, step >= 3600 ? Math.floor(since / 3600) * 3600 : since, until, ...pids).all()).results;
  const out = { step, since, until };
  for (const p of pids) out[p] = [];
  for (const r of rows) out[r.pid].push([r.b, round(r.a), round(r.lo), round(r.hi)]);
  return out;
}

async function health(env) {
  const polls = (await env.DB.prepare("SELECT ts, ok, n FROM polls ORDER BY ts DESC LIMIT 12").all()).results;
  const hp = JSON.parse(await kvGet(env, "hist_probe", "null"));
  return { polls, historyRoute: hp ? { status: hp.status, n: hp.n } : null };
}

// ---------- petits outils ----------

const nowS = () => Math.floor(Date.now() / 1000);
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
function json(o, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...SEC_HEADERS },
  });
}
async function kvGet(env, k, d) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? (typeof d === "number" ? Number(r.v) : r.v) : d;
}
function kvPut(env, k, v) {
  return env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(k, String(v));
}
