// pac : collecte myUplink (cron) + API JSON + site statique.
// Secrets : MYUPLINK_CLIENT_ID, MYUPLINK_CLIENT_SECRET (wrangler secret put). Lecture seule (READSYSTEM).
// Phases maison : servies seulement sous /prive/ (Cloudflare Access + JWT vérifié ici, variables ACCESS_TEAM et ACCESS_AUD),
// ou partout avec SHOW_HOUSE = "1" (mode VM derrière une authentification).

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
// Révèlent la présence dans la maison : jamais publiés hors /prive/ (sauf SHOW_HOUSE=1).
const HOUSE = new Set(["40079", "40081", "40083"]);

// [durée, pas d'agrégation] ; "30dd" = 30 jours par jour civil UTC (bande thermique, bilan).
const RANGES = { "24h": [86400, 600], "7d": [7 * 86400, 3600], "30d": [30 * 86400, 6 * 3600], "30dd": [30 * 86400, 86400], "365d": [365 * 86400, 86400] };
// Fenêtre libre : ~400 points max par courbe. À partir d'une heure, lecture dans readings_h.
const STEPS = [300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 7 * 86400];
const MAX_SPAN = 3 * 365 * 86400;
const CACHE_S = 60;
const PRIV = "/prive";

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    let path = url.pathname, priv = false;
    if (path === PRIV) return Response.redirect(url.origin + PRIV + "/", 301);
    if (path.startsWith(PRIV + "/")) {
      // Espace privé : Access filtre en amont, le Worker revérifie le jeton (défense en profondeur).
      if (!(await accessOk(req, env))) return new Response("accès refusé", { status: 403, headers: SEC_HEADERS });
      priv = true;
      path = path.slice(PRIV.length);
      if (!path.startsWith("/api/")) {
        const u = new URL(req.url); u.pathname = path;
        const r = await env.ASSETS.fetch(new Request(u, req));
        const out = new Response(r.body, r); out.headers.set("cache-control", "no-store");
        return out;
      }
    }
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
    // Réception des quarts d'heure Leneda poussés depuis une machine au Luxembourg (Leneda refuse Cloudflare).
    if (path === "/api/ingest/grid") return ingestGrid(req, env);
    if (req.method !== "GET") return json({ error: "méthode non autorisée" }, 405);

    // Limitation de débit par IP (binding Workers Rate Limiting).
    if (env.RL) {
      const ip = req.headers.get("cf-connecting-ip") || "?";
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "trop de requêtes, réessayez dans une minute" }, 429);
    }

    const house = priv || env.SHOW_HOUSE === "1";
    // /api/cost : coût de l'électricité, seulement dans l'espace privé (ou SHOW_HOUSE=1).
    const route = { "/api/now": now, "/api/series": series, "/api/health": health, ...(house ? { "/api/cost": cost } : {}) }[path];
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
      // Le coût ne bouge qu'une fois par heure : 10 min de cache (lecture de ~10 000 lignes horaires).
      res = json(await route(env, url.searchParams, house), 200, route === cost ? 600 : CACHE_S);
    } catch (e) {
      console.error("api", url.pathname, e && e.stack || e);
      return json({ error: "erreur interne" }, 500);
    }
    ctx.waitUntil(cache.put(key, res.clone()));
    return toClient(res);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectLeneda(env).catch((e) => console.error("leneda", e && e.stack || e)));
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

// ---------- Leneda (Luxembourg) : compteur Smarty, quarts d'heure ----------
// Secrets LENEDA_API_KEY, LENEDA_ENERGY_ID, LENEDA_POD (code du point de comptage) ; LENEDA_BASE optionnel.
// Au plus une passe par heure : depuis le dernier quart d'heure moins 6 h ; une fois par jour, relecture des 3 derniers
// jours (données publiées avec retard, versions corrigées). Premier chargement : 62 jours, par tranches de 7 jours.
const LENEDA_OBIS = "1-1:1.29.0";
async function collectLeneda(env) {
  if (!env.LENEDA_API_KEY || !env.LENEDA_ENERGY_ID || !env.LENEDA_POD || env.INGEST_TOKEN) return;
  const ts = nowS();
  if ((await kvGet(env, "leneda_ts", 0)) > ts - 3540) return;
  // Le verrou horaire est posé avant l'appel : une erreur réseau ne relance pas toutes les 5 min.
  await kvPut(env, "leneda_ts", ts).run();
  const status = (o) => kvPut(env, "leneda_status", JSON.stringify({ ts, ...o })).run();
  const last = (await env.DB.prepare("SELECT MAX(ts) AS t FROM grid").first())?.t;
  const full = (await kvGet(env, "leneda_full_ts", 0)) < ts - 86400;
  let from = last ? last - (full ? 3 * 86400 : 6 * 3600) : ts - 62 * 86400;
  from = Math.max(from, ts - 62 * 86400);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19) + "Z";
  const base = env.LENEDA_BASE || "https://api.leneda.eu/api";
  let n = 0;
  for (let a = from; a < ts; a += 7 * 86400) {
    const b = Math.min(ts, a + 7 * 86400);
    const url = `${base}/metering-points/${encodeURIComponent(env.LENEDA_POD)}/time-series?obisCode=${encodeURIComponent(LENEDA_OBIS)}` +
      `&startDateTime=${encodeURIComponent(iso(a))}&endDateTime=${encodeURIComponent(iso(b))}`;
    let r;
    try {
      r = await fetch(url, { headers: { "X-API-KEY": env.LENEDA_API_KEY, "X-ENERGY-ID": env.LENEDA_ENERGY_ID, Accept: "application/json" },
        signal: AbortSignal.timeout(20000) });
    } catch (e) { await status({ status: "réseau", n }); return; }
    if (!r.ok) {
      // 403 : refus de la clé (accès au POD) ou blocage géographique. Une clé bidon tranche : 401 = la clé est en cause.
      let probe = null;
      if (r.status === 403) probe = await fetch(url, { headers: { "X-API-KEY": "invalid", "X-ENERGY-ID": "invalid" }, signal: AbortSignal.timeout(10000) })
        .then((x) => x.status).catch(() => "réseau");
      await status({ status: r.status, n, ...(probe != null ? { probe } : {}) });
      return;
    }
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.items)) { await status({ status: "format", n }); return; }
    // Le calcul suppose des kW moyens par quart d'heure : tout autre format est refusé plutôt que mal compté.
    const unit = String(j.unit ?? "kW"), step = String(j.intervalLength ?? "PT15M");
    if (unit.toLowerCase() !== "kw" || step !== "PT15M") { await status({ status: "format", unit, interval: step, n }); return; }
    const rows = j.items.filter((it) => typeof it.value === "number" && Number.isFinite(it.value) && it.startedAt)
      .map((it) => [Math.floor(Date.parse(it.startedAt) / 1000), it.value]).filter(([t]) => Number.isFinite(t));
    // Un seul statement par tranche (json_each) : pas de limite de paramètres liés.
    if (rows.length) await env.DB.prepare(
      "INSERT INTO grid (ts, kw) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true " +
      "ON CONFLICT(ts) DO UPDATE SET kw = excluded.kw").bind(JSON.stringify(rows)).run();
    n += rows.length;
  }
  if (full) await kvPut(env, "leneda_full_ts", ts).run();
  await status({ status: !last && !n ? "vide" : 200, n });
}

// POST /api/ingest/grid, Authorization: Bearer INGEST_TOKEN. Corps : { unit: "kW", interval: "PT15M", items: [[ts, kw], ...] }.
// Écriture seule : la route ne renvoie aucune donnée. Jeton comparé en temps constant.
async function ingestGrid(req, env) {
  if (req.method !== "POST") return json({ error: "méthode non autorisée" }, 405);
  if (!env.INGEST_TOKEN) return json({ error: "inconnu" }, 404);
  const got = new TextEncoder().encode(req.headers.get("authorization") || "");
  const want = new TextEncoder().encode("Bearer " + env.INGEST_TOKEN);
  let diff = got.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ (got[i] ?? 0);
  if (diff) return json({ error: "refusé" }, 401);
  if (Number(req.headers.get("content-length") || 0) > 1_000_000) return json({ error: "trop gros" }, 413);
  const j = await req.json().catch(() => null);
  if (!j || !Array.isArray(j.items) || j.items.length > 10_000) return json({ error: "format" }, 400);
  if (String(j.unit ?? "").toLowerCase() !== "kw" || j.interval !== "PT15M") return json({ error: "unité ou pas de temps inattendus" }, 400);
  const now = nowS();
  const rows = j.items.filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && r[0] % 900 === 0 && r[0] > now - 400 * 86400 && r[0] < now + 3600
    && typeof r[1] === "number" && Number.isFinite(r[1]) && r[1] >= 0 && r[1] < 1000).map((r) => [r[0], r[1]]);
  // Nouvelles données compteur : le coût mis en cache est recalculé à la prochaine demande.
  const stmts = [kvPut(env, "leneda_status", JSON.stringify({ ts: now, status: 200, n: rows.length, via: "push" })), env.DB.prepare("DELETE FROM kv WHERE k = 'cost_cache'")];
  if (rows.length) stmts.unshift(env.DB.prepare(
    "INSERT INTO grid (ts, kw) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true " +
    "ON CONFLICT(ts) DO UPDATE SET kw = excluded.kw").bind(JSON.stringify(rows)));
  await env.DB.batch(stmts);
  return json({ ok: true, n: rows.length, rejected: j.items.length - rows.length });
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

async function now(env, _q, house) {
  const pub = TRACKED.filter((p) => house || !HOUSE.has(p));
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
    house: !!house,
    poll: { last: last ? { ts: last.ts, ok: last.ok } : null, lastOk: lastOk?.ts ?? null },
    server: nowS(),
  };
}

function pickStep(span) { return STEPS.find((s) => span / s <= 400) || STEPS[STEPS.length - 1]; }

async function series(env, q, house) {
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
    .filter((p) => TRACKED.includes(p) && (house || !HOUSE.has(p))).slice(0, 12);
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

// ---------- coût de l'électricité (privé) ----------
// PAC : moyenne horaire des compteurs NIBE « consommé, heure passée » (kWh), appoint compris.
// Maison : 3 phases (A) × 230 V, estimation en puissance apparente (pas de cos φ).
// Tarif : PRICE_KWH (TTC, base ou heures pleines), PRICE_HC + HC_HOURS ("22-6", "23:30-7:30,12-14"),
// MONTHLY_FEE (abonnement TTC par mois, optionnel), TIMEZONE ; Leneda : PREF_KW (puissance de référence)
// et OVERRUN_KWH (prix TTC du kWh au-delà de Pref, par quart d'heure).
const USE = ["32495", "32496", "32499", "32500"];
const VOLT = 230;
function tariff(env) {
  const num = (v) => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
  const hc = num(env.PRICE_HC), hcHours = String(env.HC_HOURS || "22-6");
  const ranges = hc ? hcHours.split(",").map((r) => r.split("-").map((x) => { if (!/^\s*\d{1,2}(:\d{2})?\s*$/.test(x)) return NaN; const [h, m] = x.trim().split(":").map(Number); return h * 60 + (m || 0); }))
    .filter((r) => r.length === 2 && r.every((v) => Number.isFinite(v) && v >= 0 && v <= 1440)) : [];
  return { tz: env.TIMEZONE || "Europe/Paris", base: num(env.PRICE_KWH) ?? 0.1952, hc: ranges.length ? hc : null, hcHours: ranges.length ? hcHours : null, ranges, monthly: num(env.MONTHLY_FEE),
    pref: num(env.PREF_KW), overrun: num(env.OVERRUN_KWH) };
}
const inRange = (m, [a, b]) => (a <= b ? m >= a && m < b : m >= a || m < b);

// Le calcul lit ~16 000 lignes : résultat gardé en base une heure (clé = tarif), recalculé à la demande.
async function cost(env) {
  const T = tariff(env), key = JSON.stringify(T);
  const c = JSON.parse(await kvGet(env, "cost_cache", "null"));
  if (c && c.key === key && c.ts > nowS() - 3600) return c.data;
  const data = await costCompute(env, T);
  await kvPut(env, "cost_cache", JSON.stringify({ ts: nowS(), key, data })).run();
  return data;
}

async function costCompute(env, T) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: T.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const lc = new Map();
  const local = (ts) => {
    let l = lc.get(ts); if (l) return l;
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
    l = { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) }; lc.set(ts, l); return l;
  };
  const pids = [...USE, ...HOUSE];
  const since = Math.floor((nowS() - 62 * 86400) / 3600) * 3600;
  const rows = (await env.DB.prepare(`SELECT ts, pid, a FROM readings_h WHERE ts >= ? AND pid IN (${pids.map(() => "?").join(",")})`)
    .bind(since, ...pids).all()).results;
  const hours = new Map();
  for (const r of rows) {
    let h = hours.get(r.ts);
    if (!h) hours.set(r.ts, (h = { pac: null, amps: 0, ph: 0, w: 1 }));
    // Heure en cours : comptée au prorata du temps écoulé, sinon elle pèserait une heure pleine.
    if (HOUSE.has(r.pid)) { h.amps += r.a; h.ph++; h.w = Math.min(1, Math.max(0, nowS() - r.ts) / 3600); } else h.pac = (h.pac ?? 0) + r.a;
  }
  const days = new Map();
  for (const ts of [...hours.keys()].sort((a, b) => a - b)) {
    const h = hours.get(ts), { day, min } = local(ts);
    let d = days.get(day);
    if (!d) days.set(day, (d = { d: day, hp: 0, hc: 0, hours: 0, house: 0, houseHours: 0 }));
    // Part en heures creuses, sondée à :15 et :45 (tranches d'une demi-heure).
    const f = T.hc ? [15, 45].filter((m) => T.ranges.some((r) => inRange((min + m) % 1440, r))).length / 2 : 0;
    if (h.pac != null) { d.hp += h.pac * (1 - f); d.hc += h.pac * f; d.hours++; }
    if (h.ph === 3) { d.house += (h.amps * VOLT * h.w) / 1000; d.houseHours += h.w; }
  }
  // Compteur (Leneda) : kWh = kW moyen × 0,25 h ; dépassement = part au-delà de Pref, quart d'heure par quart d'heure.
  // Table absente (migration 0003 pas encore appliquée) : pas de données compteur, le reste fonctionne.
  const grid = env.LENEDA_POD ? (await env.DB.prepare("SELECT ts, kw FROM grid WHERE ts >= ?").bind(since).all().catch(() => ({ results: [] }))).results : [];
  for (const q of grid) {
    const l = local(Math.floor(q.ts / 3600) * 3600);
    let d = days.get(l.day);
    if (!d) days.set(l.day, (d = { d: l.day, hp: 0, hc: 0, hours: 0, house: 0, houseHours: 0 }));
    d.grid = (d.grid ?? 0) + q.kw * 0.25; d.gridQ = (d.gridQ ?? 0) + 1;
    d.peak = Math.max(d.peak ?? 0, q.kw);
    if (T.pref) d.over = (d.over ?? 0) + Math.max(0, q.kw - T.pref) * 0.25;
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    tariff: { base: T.base, hc: T.hc, hcHours: T.hcHours, tz: T.tz, monthly: T.monthly, pref: T.pref, overrun: T.overrun },
    today: local(nowS()).day,
    days: [...days.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).map((d) => ({ ...d, hp: r3(d.hp), hc: r3(d.hc), house: r3(d.house), houseHours: r3(d.houseHours),
      ...(d.gridQ ? { grid: r3(d.grid), over: r3(d.over ?? 0), peak: r3(d.peak) } : {}) })),
  };
}

async function health(env, _q, house) {
  const polls = (await env.DB.prepare("SELECT ts, ok, n FROM polls ORDER BY ts DESC LIMIT 12").all()).results;
  const hp = JSON.parse(await kvGet(env, "hist_probe", "null"));
  const ln = JSON.parse(await kvGet(env, "leneda_status", "null"));
  return { polls, historyRoute: hp ? { status: hp.status, n: hp.n } : null, ...(house ? { leneda: ln ? { ts: ln.ts, status: ln.status, n: ln.n ?? null, probe: ln.probe ?? null } : null } : {}) };
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

// ---------- Cloudflare Access ----------
// Vérifie Cf-Access-Jwt-Assertion : RS256, émetteur = équipe Access, audience = AUD de l'application, non expiré.
let ACCESS_KEYS = null, ACCESS_KEYS_AT = 0;
async function accessKeys(iss, force) {
  if (!force && ACCESS_KEYS && Date.now() - ACCESS_KEYS_AT < 3600e3) return ACCESS_KEYS;
  const r = await fetch(iss + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("certs " + r.status);
  ACCESS_KEYS = (await r.json()).keys || []; ACCESS_KEYS_AT = Date.now();
  return ACCESS_KEYS;
}
const b64u = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((x.length + 3) % 4)), (c) => c.charCodeAt(0));
export async function accessOk(req, env) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return false;
  const jwt = req.headers.get("cf-access-jwt-assertion") || "";
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return false;
  try {
    const td = new TextDecoder();
    const head = JSON.parse(td.decode(b64u(h))), pay = JSON.parse(td.decode(b64u(p)));
    const iss = `https://${env.ACCESS_TEAM}.cloudflareaccess.com`;
    const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
    if (head.alg !== "RS256" || pay.iss !== iss || !aud.includes(env.ACCESS_AUD) || !(pay.exp > nowS())) return false;
    let jwk = (await accessKeys(iss)).find((k) => k.kid === head.kid);
    if (!jwk) jwk = (await accessKeys(iss, true)).find((k) => k.kid === head.kid); // rotation des clés
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(h + "." + p));
  } catch (e) {
    console.error("access", e && e.message || e);
    return false;
  }
}
