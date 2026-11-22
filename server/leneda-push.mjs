// Leneda -> Worker : à lancer toutes les heures sur une machine au Luxembourg (Leneda refuse les IP de Cloudflare,
// d'OVH France, etc.). Lit les quarts d'heure (OBIS 1-1:1.29.0, kW) et les pousse sur POST /api/ingest/grid.
// Env : LENEDA_API_KEY, LENEDA_ENERGY_ID, LENEDA_POD, PUSH_URL (https://<hôte>/api/ingest/grid), INGEST_TOKEN,
// LENEDA_BASE (https://api.leneda.eu/api), STATE_FILE (./data/leneda-state.json).
// Premier passage : 62 jours. Ensuite : depuis le dernier quart d'heure reçu moins 3 jours (retards, corrections).
// Partage communauté énergétique (OBIS 1-65:1.29.2 couche 3 « CEL » communauté locale + 1-65:1.29.4 couche 4
// « CEN » réseau national, additionnés) : publié avec ~1 mois de retard, donc relu une fois par jour
// depuis le dernier quart d'heure partagé connu moins 3 jours (SHARED=0 pour désactiver).
// Lancement : node --env-file=leneda.env server/leneda-push.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const need = ["LENEDA_API_KEY", "LENEDA_ENERGY_ID", "LENEDA_POD", "PUSH_URL", "INGEST_TOKEN"];
for (const k of need) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(1); }
const E = process.env, BASE = E.LENEDA_BASE || "https://api.leneda.eu/api", STATE = E.STATE_FILE || "./data/leneda-state.json";
const now = Math.floor(Date.now() / 1000), DAY = 86400;
let state = {};
try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
const sharing = E.SHARED !== "0";
const longRun = sharing && (!state.sharedRun || state.sharedRun < now - DAY);
let from = Math.max(now - 62 * DAY, state.last ? state.last - 3 * DAY : 0);
if (longRun) from = Math.max(now - 62 * DAY, Math.min(from, state.lastShared ? state.lastShared - 3 * DAY : 0));
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19) + "Z";

async function series(obis, a, b) {
  const url = `${BASE}/metering-points/${encodeURIComponent(E.LENEDA_POD)}/time-series?obisCode=${encodeURIComponent(obis)}` +
    `&startDateTime=${encodeURIComponent(iso(a))}&endDateTime=${encodeURIComponent(iso(b))}`;
  const r = await fetch(url, { headers: { "X-API-KEY": E.LENEDA_API_KEY, "X-ENERGY-ID": E.LENEDA_ENERGY_ID, Accept: "application/json" },
    signal: AbortSignal.timeout(30000) });
  if (!r.ok) { console.error(new Date().toISOString(), "leneda", obis, r.status, iso(a)); process.exit(2); }
  const j = await r.json();
  if ((j.items || []).length && (String(j.unit ?? "kW").toLowerCase() !== "kw" || String(j.intervalLength ?? "PT15M") !== "PT15M")) {
    console.error("unexpected format", obis, j.unit, j.intervalLength); process.exit(3);
  }
  return new Map((j.items || []).filter((it) => typeof it.value === "number" && it.startedAt)
    .map((it) => [Math.floor(Date.parse(it.startedAt) / 1000), it.value]).filter(([t]) => Number.isFinite(t) && t % 900 === 0));
}

let last = state.last || 0, lastShared = state.lastShared || 0, total = 0, shared = 0;
for (let a = from; a < now; a += 7 * DAY) {
  const b = Math.min(now, a + 7 * DAY);
  const kw = await series("1-1:1.29.0", a, b);
  const sh = new Map();
  if (sharing) for (const obis of ["1-65:1.29.2", "1-65:1.29.4"]) for (const [t, v] of await series(obis, a, b)) sh.set(t, (sh.get(t) ?? 0) + v);
  const items = [...kw].map(([t, v]) => [t, v, sh.has(t) ? Math.min(sh.get(t), v) : null]);
  if (!items.length) continue;
  shared += items.filter((i) => i[2] != null).length;
  for (const i of items) if (i[2] != null) lastShared = Math.max(lastShared, i[0]);
  const p = await fetch(E.PUSH_URL, { method: "POST", headers: { Authorization: `Bearer ${E.INGEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ unit: "kW", interval: "PT15M", items }), signal: AbortSignal.timeout(30000) });
  const out = await p.json().catch(() => ({}));
  if (!p.ok) { console.error(new Date().toISOString(), "push", p.status, out.error || ""); process.exit(4); }
  total += out.n || 0;
  last = Math.max(last, ...items.map((i) => i[0]));
}
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify({ last, lastShared, run: now, sharedRun: longRun ? now : state.sharedRun || 0 }));
console.log(new Date().toISOString(), "ok", total, "quarter-hours, last", last ? iso(last) : "-",
  sharing ? `· shared ${shared}, last ${lastShared ? iso(lastShared) : "-"}` : "");
