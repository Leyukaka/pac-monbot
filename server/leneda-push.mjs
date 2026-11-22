// Leneda -> Worker : à lancer toutes les heures sur une machine au Luxembourg (Leneda refuse les IP de Cloudflare,
// d'OVH France, etc.). Lit les quarts d'heure (OBIS 1-1:1.29.0, kW) et les pousse sur POST /api/ingest/grid.
// Env : LENEDA_API_KEY, LENEDA_ENERGY_ID, LENEDA_POD, PUSH_URL (https://<hôte>/api/ingest/grid), INGEST_TOKEN,
// LENEDA_BASE (https://api.leneda.eu/api), STATE_FILE (./data/leneda-state.json).
// Premier passage : 62 jours. Ensuite : depuis le dernier quart d'heure reçu moins 3 jours (retards, corrections).
// Lancement : node --env-file=leneda.env server/leneda-push.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const need = ["LENEDA_API_KEY", "LENEDA_ENERGY_ID", "LENEDA_POD", "PUSH_URL", "INGEST_TOKEN"];
for (const k of need) if (!process.env[k]) { console.error(`missing ${k}`); process.exit(1); }
const E = process.env, BASE = E.LENEDA_BASE || "https://api.leneda.eu/api", STATE = E.STATE_FILE || "./data/leneda-state.json";
const now = Math.floor(Date.now() / 1000), DAY = 86400;
let state = {};
try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
const from = Math.max(now - 62 * DAY, state.last ? state.last - 3 * DAY : 0);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19) + "Z";

let last = state.last || 0, total = 0;
for (let a = from; a < now; a += 7 * DAY) {
  const b = Math.min(now, a + 7 * DAY);
  const url = `${BASE}/metering-points/${encodeURIComponent(E.LENEDA_POD)}/time-series?obisCode=${encodeURIComponent("1-1:1.29.0")}` +
    `&startDateTime=${encodeURIComponent(iso(a))}&endDateTime=${encodeURIComponent(iso(b))}`;
  const r = await fetch(url, { headers: { "X-API-KEY": E.LENEDA_API_KEY, "X-ENERGY-ID": E.LENEDA_ENERGY_ID, Accept: "application/json" },
    signal: AbortSignal.timeout(30000) });
  if (!r.ok) { console.error(new Date().toISOString(), "leneda", r.status, iso(a)); process.exit(2); }
  const j = await r.json();
  if (String(j.unit ?? "kW").toLowerCase() !== "kw" || String(j.intervalLength ?? "PT15M") !== "PT15M") {
    console.error("unexpected format", j.unit, j.intervalLength); process.exit(3);
  }
  const items = (j.items || []).filter((it) => typeof it.value === "number" && it.startedAt)
    .map((it) => [Math.floor(Date.parse(it.startedAt) / 1000), it.value]).filter(([t]) => Number.isFinite(t) && t % 900 === 0);
  if (!items.length) continue;
  const p = await fetch(E.PUSH_URL, { method: "POST", headers: { Authorization: `Bearer ${E.INGEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ unit: "kW", interval: "PT15M", items }), signal: AbortSignal.timeout(30000) });
  const out = await p.json().catch(() => ({}));
  if (!p.ok) { console.error(new Date().toISOString(), "push", p.status, out.error || ""); process.exit(4); }
  total += out.n || 0;
  last = Math.max(last, ...items.map((i) => i[0]));
}
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify({ last, run: now }));
console.log(new Date().toISOString(), "ok", total, "quarter-hours, last", last ? iso(last) : "-");
