// PAC/POWER · page Coûts (espace privé) : rendu de /prive/api/costdata, tout est calculé dans le navigateur. Aucune dépendance.
// Nommé couts.js : pas de « analyse » ni « stats » dans le nom (bloqueurs de pub).
(() => {
  "use strict";

  // ---------- calcul pur (aucun accès au DOM, testable sous Node) ----------
  const Q = 0.25; // h par quart d'heure
  const FIX = { 3: 7.42, 7: 12.84, 12: 19.61, 17: 26.39 }; // Creos 2026, HT/mois (switchr.lu / ILR)
  const METER = 5.72, SUPPLIER_FIX = 1.5; // comptage HT, part fixe fournisseur HT (prime 4 − remise 2,50)
  const fixedMonthly = (p, vat) => (FIX[p] + METER + SUPPLIER_FIX) * (1 + (vat ?? 0.08));
  const PV_M = [27, 45, 80, 113, 128, 132, 135, 120, 92, 60, 30, 22]; // kWh/kWc par mois, Luxembourg
  const PV_YEAR = PV_M.reduce((s, v) => s + v, 0);
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ORIENT = { s: 1, eo: 0.85, e: 0.8, o: 0.8 };
  const NOON_UTC = 11 + 35 / 60; // 12:35 heure d'hiver = 13:35 heure d'été = 11:35 UTC
  // durée du jour : 8 h vers le 21 décembre, 16,3 h vers le 21 juin, sinusoïde entre les deux
  const dayLen = (doy) => 12.15 - 4.15 * Math.cos((2 * Math.PI * (doy + 10)) / 365);

  // « 22-6 », « 23:30-7:30,12-14 » -> [[min début, min fin], ...] ; null si illisible
  function parseRanges(s) {
    const out = [];
    for (const part of String(s ?? "").split(/[,;]/)) {
      const t = part.trim(); if (!t) continue;
      const m = t.match(/^(\d{1,2})(?:[:h.](\d{2}))?\s*(?:h)?\s*[-–à]\s*(\d{1,2})(?:[:h.](\d{2}))?\s*(?:h)?$/i); if (!m) return null;
      const a = +m[1] * 60 + (+m[2] || 0), b = +m[3] * 60 + (+m[4] || 0);
      if (a > 1440 || b > 1440 || +m[2] > 59 || +m[4] > 59) return null;
      out.push([a % 1440, b % 1440]);
    }
    return out.length ? out : null;
  }
  const inRanges = (rs, m) => rs.some(([a, b]) => (a === b ? true : a < b ? m >= a && m < b : m >= a || m < b));

  // Une ligne par quart d'heure : énergie, partage, heure locale, prix et tranche. Heure locale mise en cache par heure pleine.
  function prep(D) {
    const T = D.tariff, P = T.prices;
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: D.tz || "Europe/Luxembourg", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const cache = new Map();
    const local = (sec) => {
      const hk = Math.floor(sec / 3600); let c = cache.get(hk);
      if (!c) { const p = {}; for (const x of fmt.formatToParts(new Date(hk * 3600e3))) p[x.type] = x.value;
        const y = +p.year, mo = +p.month, d = +p.day;
        c = { mo: mo - 1, day: `${p.year}-${p.month}-${p.day}`, doy: Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1,
          h: +p.hour % 24, mi: +p.minute, we: p.weekday === "Sat" || p.weekday === "Sun" };
        cache.set(hk, c); }
      return [c, (sec - hk * 3600) / 60];
    };
    const all = [...P.wd, ...P.we], pmin = Math.min(...all), pmax = Math.max(...all);
    const band = (p) => (pmax - pmin < 1e-9 ? "base" : p - pmin < 1e-9 ? "creuse" : pmax - p < 1e-9 ? "pointe" : "base");
    const rows = [];
    for (const [ts, kw, sk] of D.q || []) {
      if (kw == null || !Number.isFinite(+kw)) continue;
      const sec = ts > 1e11 ? ts / 1000 : ts, [c, dm] = local(sec), price = (c.we ? P.we : P.wd)[c.h];
      const k = Math.max(0, +kw), kwh = k * Q;
      rows.push({ kw: k, kwh, sh: sk == null ? 0 : Math.min(kwh, Math.max(0, +sk) * Q), h: c.h, m: c.h * 60 + c.mi + dm, we: c.we,
        mo: c.mo, doy: c.doy, day: c.day, utcH: (((sec % 86400) + 86400) % 86400) / 3600, price, band: band(price) });
    }
    return { rows, days: rows.length / 96, pmin, pmax, pavg: all.reduce((s, v) => s + v, 0) / all.length };
  }

  const bandsZero = () => ({ creuse: { kwh: 0, eur: 0 }, base: { kwh: 0, eur: 0 }, pointe: { kwh: 0, eur: 0 } });
  // coût variable : la part partagée reste au prix du partage dans toutes les offres
  function varCost(rows, shared, priceOf) {
    let eur = 0, kwh = 0; const b = bandsZero();
    for (const r of rows) { const p = priceOf(r), c = (r.kwh - r.sh) * p + r.sh * (shared ?? p);
      eur += c; kwh += r.kwh; b[r.band].kwh += r.kwh; b[r.band].eur += c; }
    return { eur, kwh, bands: b };
  }
  // offre : coût sur la période (variable + fixe au prorata) et sur 12 mois (règle de trois sur les jours couverts)
  function offer(rows, days, shared, priceOf, monthly) {
    const v = varCost(rows, shared, priceOf), fixed = (monthly * 12 * days) / 365, period = v.eur + fixed;
    return { var: v.eur, kwh: v.kwh, fixed, period, year: days > 0 ? (period * 365) / days : NaN, bands: v.bands };
  }
  function overrun(rows, pref) {
    let kwh = 0, n = 0; for (const r of rows) if (r.kw > pref) { kwh += (r.kw - pref) * Q; n++; }
    return { kwh, n };
  }
  function shareReal(rows, shared) {
    const b = bandsZero(); let kwh = 0, eur = 0;
    for (const r of rows) if (r.sh > 0) { const g = r.sh * (r.price - shared); b[r.band].kwh += r.sh; b[r.band].eur += g; kwh += r.sh; eur += g; }
    return { kwh, eur, bands: b };
  }
  function shareSim(rows, o) {
    const b = bandsZero(); let kwh = 0, eur = 0;
    for (const r of rows) {
      if ((o.days === "wd" && r.we) || (o.days === "we" && !r.we) || !inRanges(o.ranges, r.m)) continue;
      const s = Math.min(r.kwh, o.part * r.kwh), g = s * (r.price - o.price);
      b[r.band].kwh += s; b[r.band].eur += g; kwh += s; eur += g;
    }
    return { kwh, eur, bands: b };
  }
  // énergie produite sur [a, b] (heures UTC) d'une journée de E kWh en cloche (sinus) entre lever et coucher
  function pvSlice(E, doy, a, b) {
    const L = dayLen(doy), rise = NOON_UTC - L / 2, set = rise + L;
    const x = Math.max(a, rise), y = Math.min(b, set); if (y <= x) return 0;
    return (E / 2) * (Math.cos((Math.PI * (x - rise)) / L) - Math.cos((Math.PI * (y - rise)) / L));
  }
  function solar(rows, days, o) {
    const f = o.kwc * (ORIENT[o.or] ?? 1), sell = o.inject ? (o.community ? o.cprice : o.tariff) : 0;
    let prod = 0, self = 0, surplus = 0, saved = 0, income = 0, cons = 0;
    const cH = Array(24).fill(0), pH = Array(24).fill(0);
    for (const r of rows) {
      const E = (f * PV_M[r.mo]) / DIM[r.mo], p = pvSlice(E, r.doy, r.utcH, r.utcH + Q), s = Math.min(p, r.kwh);
      prod += p; self += s; surplus += p - s; saved += s * r.price; income += (p - s) * sell; cons += r.kwh;
      cH[r.h] += r.kwh; pH[r.h] += p;
    }
    const d = Math.max(days, 1e-9), yearProd = f * PV_YEAR, perKwh = prod > 0 ? (saved + income) / prod : 0;
    return { prod, self, surplus, saved, income, cons, gain: saved + income, yearProd, yearGain: yearProd * perKwh, perKwh,
      selfRate: prod > 0 ? self / prod : NaN, autoRate: cons > 0 ? self / cons : NaN, cH: cH.map((v) => v / d), pH: pH.map((v) => v / d) };
  }
  const CORE = { FIX, fixedMonthly, PV_M, PV_YEAR, dayLen, parseRanges, inRanges, prep, varCost, offer, overrun, shareReal, shareSim, pvSlice, solar };
  if (typeof document === "undefined") { globalThis.COUTS_CORE = CORE; return; } // tests Node

  // ---------- page ----------
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (t, a = {}, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  // Langue (site/i18n.js) : texte source français traduit par tr() ; nombres et dates au format de la langue.
  const tr = (s, v) => (window.I18N ? window.I18N.t(s, v) : s), LOC = window.I18N?.locale || "fr-FR";
  const fr = (v, d = 1) => v == null || !Number.isFinite(v) ? "-" : v.toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v, d = 2) => fr(v, d) + " €";
  const sgn = (v, d = 2) => (!Number.isFinite(v) ? "-" : (v >= 0 ? "+" : "−") + eur(Math.abs(v), d));
  const pct = (v, d = 0) => fr(100 * v, d) + " %";
  const BANDS = [["creuse", tr("Creuse"), "var(--t-cool)"], ["base", tr("Base"), "var(--t-warm)"], ["pointe", tr("Pointe"), "var(--t-hot)"]];
  const BASE = location.pathname.startsWith("/prive/") ? "/prive" : "";
  const day = (k) => new Date(k + "T12:00:00Z").toLocaleDateString(LOC, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const cell = (lab, val, sub, cls = "", col) => `<div class="a-cell"><span class="label"${col ? ` style="color:${col}"` : ""}>${lab}</span><b class="${cls}">${val}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
  const dd = (lab, val, cls = "") => `<div><dt>${lab}</dt><dd class="${cls}">${val}</dd></div>`;

  // bulle partagée (même comportement que la page Analyse)
  const tip = document.createElement("div"); tip.className = "tip num"; tip.hidden = true; document.body.appendChild(tip);
  const trow = (c, n, v) => `<div><i style="background:${c}"></i>${n}<b>${v}</b></div>`;
  function hover(svg, fn) {
    const hide = () => { tip.hidden = true; };
    const move = (e) => {
      const m = svg.getScreenCTM(); if (!m) return hide();
      const r = fn(new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())); if (!r) return hide();
      tip.innerHTML = r; tip.hidden = false;
      const w = tip.offsetWidth, h = tip.offsetHeight, touch = e.pointerType === "touch";
      let x = e.clientX + 16, y = touch ? e.clientY - h - 28 : e.clientY + 16;
      if (x + w > innerWidth - 8) x = Math.max(8, e.clientX - w - 16);
      if (y + h > innerHeight - 8 || y < 8) y = Math.max(8, e.clientY - h - 16);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); });
    addEventListener("scroll", hide, { passive: true });
  }

  // saisies mémorisées (localStorage facultatif)
  const KEY = "couts.v1";
  let S = {}; try { S = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { S = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
  const inputs = () => [...document.querySelectorAll(".c-in")];
  const num = (id, def = 0) => { const v = parseFloat(String($(id).value).replace(",", ".")); return Number.isFinite(v) ? v : def; };
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  let D = null, M = null, T = null, PREF = 7, inited = false;

  function initInputs() {
    const DEF = { "o1-p": r4(M.pavg), "o1-f": T.monthly, "o2-hc": r4(M.pmin), "o2-hp": r4(M.pmax), "o2-r": "22-6", "o2-f": T.monthly,
      "ov-p": T.overrun ?? 0, "cm-on": false, "cm-price": T.shared ?? 0.16, "cm-part": 30, "cm-range": "10-16", "cm-days": "all",
      "pv-on": false, "pv-kwc": 6, "pv-or": "s", "pv-inj": true, "pv-tar": 0.08, "pv-cm": false, "pv-cmp": 0.09 };
    for (const e of inputs()) { const v = S[e.id] ?? DEF[e.id]; if (v == null) continue; if (e.type === "checkbox") e.checked = !!v; else e.value = v; }
    PREF = FIX[S.pref] ? +S.pref : FIX[T.pref] ? T.pref : 7;
    inited = true;
  }
  document.addEventListener("input", (e) => { const t = e.target; if (!t.classList?.contains("c-in") || !inited || !M?.rows.length) return;
    S[t.id] = t.type === "checkbox" ? t.checked : t.value; save(); renderSims(); });
  $("c-pref").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || !inited || !M?.rows.length) return; PREF = +b.dataset.p; S.pref = PREF; save(); renderPref(); });

  // 1-2. coûts réels
  function renderSummary() {
    const o = offer(M.rows, M.days, T.shared, (r) => r.price, T.monthly);
    $("c-sum").innerHTML = cell(tr("Consommation"), fr(o.kwh, 0) + " kWh", tr("{n} jours de données", { n: fr(M.days, 1) })) +
      cell(tr("Coût variable"), eur(o.var), tr("énergie, taxes, réseau, TVA")) +
      cell(tr("Part fixe"), eur(o.fixed), tr("{m} par mois au prorata", { m: eur(T.monthly) })) +
      cell(tr("Total"), eur(o.period), tr("sur la période")) +
      cell(tr("Prix moyen"), fr(o.kwh > 0 ? o.period / o.kwh : NaN, 3) + " €/kWh", tr("tout compris, fixe inclus")) +
      cell(tr("Projection 12 mois"), eur(o.year, 0), tr("extrapolation"));
    const sh = BANDS.filter(([k]) => o.bands[k].kwh > 0);
    $("c-bands").innerHTML = sh.map(([k, n, c]) => cell(n, eur(o.bands[k].eur), `${fr(o.bands[k].kwh, 0)} kWh · ${pct(o.bands[k].kwh / Math.max(o.kwh, 1e-9))} · ${fr(o.bands[k].kwh > 0 ? o.bands[k].eur / o.bands[k].kwh : NaN, 3)} €/kWh`, "", c)).join("");
    $("c-bands-l").textContent = tr("creuse {a} €, pointe {b} €", { a: fr(M.pmin, 4), b: fr(M.pmax, 4) });
    $("c-sum-why").textContent = tr("Part fixe : abonnement de {m} TTC par mois, compté au prorata des {n} jours de données.", { m: eur(T.monthly), n: fr(M.days, 1) }) + " " +
      tr("La projection sur 12 mois est une règle de trois sur les jours couverts : c'est une extrapolation, l'hiver pèse plus que l'été (chauffage par la PAC), le résultat dépend donc beaucoup de la saison couverte.");
    return o;
  }

  // 3. offres
  function renderOffers(cur) {
    const ranges = parseRanges($("o2-r").value), okR = !!ranges;
    $("o2-r").setAttribute("aria-invalid", String(!okR)); $("o2-err").hidden = okR;
    const single = offer(M.rows, M.days, T.shared, () => num("o1-p"), num("o1-f"));
    const hc = num("o2-hc"), hp = num("o2-hp");
    const hchp = okR ? offer(M.rows, M.days, T.shared, (r) => (inRanges(ranges, r.m) ? hc : hp), num("o2-f")) : null;
    $("o0-desc").textContent = tr("Grille horaire de ton contrat : de {a} à {b} €/kWh selon l'heure, fixe {m} par mois.", { a: fr(M.pmin, 4), b: fr(M.pmax, 4), m: eur(T.monthly) });
    const res = (o) => {
      if (!o) return dd(tr("Sur la période"), "-");
      const d = o.year - cur.year, cls = Math.abs(d) < 0.005 ? "" : d < 0 ? "pos" : "neg";
      return dd(tr("Sur la période"), eur(o.period)) + dd(tr("Sur 12 mois (extrapolé)"), eur(o.year, 0)) +
        (o === cur ? dd(tr("Écart"), tr("référence")) : dd(tr("Écart sur 12 mois"), `${sgn(d, 0)} · ${d >= 0 ? "+" : "−"}${pct(Math.abs(d) / Math.max(cur.year, 1e-9), 1)}`, cls)) +
        dd(tr("Prix moyen"), fr(o.kwh > 0 ? o.period / o.kwh : NaN, 3) + " €/kWh");
    };
    $("o0-res").innerHTML = res(cur); $("o1-res").innerHTML = res(single); $("o2-res").innerHTML = res(hchp);
    const list = [[tr("Ton offre actuelle"), cur], [tr("Prix unique"), single], [tr("Heures creuses / pleines"), hchp]].filter(([, o]) => o);
    const best = list.reduce((a, b) => (b[1].year < a[1].year - 0.005 ? b : a));
    $("c-best").innerHTML = best[1] === cur
      ? tr("La meilleure offre pour ta consommation : {o}.", { o: `<b>${tr("ton offre actuelle")}</b>` })
      : tr("La meilleure offre pour ta consommation : {o}, {e} de moins par an que ton offre actuelle.", { o: `<b>${best[0]}</b>`, e: `<b class="pos">${eur(cur.year - best[1].year, 0)}</b>` });
  }

  // 4. puissance de référence
  function renderPref() {
    $("c-pref").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.p === PREF)));
    const vat = T.vat ?? 0.08, price = num("ov-p"), mpd = 365 / 12 / Math.max(M.days, 1e-9);
    const now = FIX[T.pref] ? T.pref : null, o = overrun(M.rows, PREF), oNow = overrun(M.rows, T.pref ?? PREF);
    const fx = fixedMonthly(PREF, vat), fxNow = T.monthly;
    const ovM = o.kwh * mpd * price, ovNowM = oNow.kwh * mpd * price;
    const tot = fx + ovM, totNow = fxNow + ovNowM, d = tot - totNow, n = M.rows.length;
    $("ov-note").textContent = T.overrun == null
      ? tr("Dépassement pas facturé aujourd'hui sur ta facture : 0 par défaut. Saisis un prix pour voir ce que coûterait un dépassement facturé.")
      : tr("Prix du dépassement de ton tarif : {p} €/kWh.", { p: fr(T.overrun, 4) });
    $("c-pref-cells").innerHTML =
      cell(tr("Fixe mensuel"), eur(fx), tr("{k} kW · actuel {m}", { k: PREF, m: eur(fxNow) })) +
      cell(tr("Au-delà de {k} kW", { k: PREF }), fr(o.kwh, 1) + " kWh", tr("{q} quarts d'heure sur {n} ({p})", { q: o.n, n, p: pct(o.n / Math.max(n, 1), 1) })) +
      cell(tr("Dépassement par mois"), eur(ovM), tr("{k} kWh par mois en moyenne", { k: fr(o.kwh * mpd, 1) })) +
      cell(tr("Total par mois"), eur(tot), tr("fixe + dépassement · actuel {m}", { m: eur(totNow) })) +
      cell(tr("Écart par mois"), sgn(d), tr("{y} par an", { y: sgn(d * 12, 0) }), Math.abs(d) < 0.005 ? "" : d < 0 ? "pos" : "neg");
    $("c-pref-why").textContent = tr("Fixe = (frais Creos {f} + comptage 5,72 + part fournisseur 1,50) € HT × (1 + TVA {v}).", { f: fr(FIX[PREF], 2), v: pct(vat, 0) }) + " " +
      (now ? tr("Contrôle : à {k} kW la formule donne {a}, ta facture {b}.", { k: now, a: eur(fixedMonthly(now, vat)), b: eur(T.monthly) }) + " " : "") +
      tr("L'actuel est compté avec le même prix de dépassement, pour comparer à règles égales. Moyenne mensuelle = règle de trois sur les jours couverts : l'hiver, la PAC tire plus de puissance.");
  }

  // 5. communauté
  function renderShare() {
    const on = $("cm-on").checked; $("cm-form").hidden = !on;
    const real = T.shared != null ? shareReal(M.rows, T.shared) : null, yf = 365 / Math.max(M.days, 1e-9);
    const bandCells = (s, gainWord) => BANDS.filter(([k]) => s.bands[k].kwh > 0).map(([k, n, c]) =>
      cell(n, fr(s.bands[k].kwh, 0) + " kWh", `${s.bands[k].eur >= 0 ? gainWord : tr("surcoût")} ${eur(Math.abs(s.bands[k].eur))}`, "", c)).join("");
    const pmin = fr(M.pmin, 4);
    if (!on) {
      $("cm-err").hidden = true;
      $("cm-h").textContent = tr("Bilan réel du partage"); $("cm-l").textContent = tr("communauté contre fournisseur, au même quart d'heure");
      if (!real || real.kwh <= 0) { $("cm-cells").innerHTML = ""; $("cm-why").textContent = tr("Pas de partage publié sur cette période (Leneda publie avec environ un mois de retard)."); return; }
      $("cm-cells").innerHTML = bandCells(real, tr("économie")) +
        cell(tr("Total"), sgn(real.eur), tr("{v} kWh partagés", { v: fr(real.kwh, 0) }), real.eur >= 0 ? "pos" : "neg");
      $("cm-why").textContent = tr("Un kWh partagé coûte {s} € tout compris, un kWh creux chez le fournisseur {c} €.", { s: fr(T.shared, 4), c: pmin }) + " " +
        tr("Le partage n'est gagnant que quand il remplace des kWh plus chers que lui : il perd de l'argent quand il remplace des kWh creux moins chers que lui.");
      return;
    }
    const ranges = parseRanges($("cm-range").value), part = Math.min(100, Math.max(0, num("cm-part"))) / 100, cp = num("cm-price");
    $("cm-range").setAttribute("aria-invalid", String(!ranges)); $("cm-err").hidden = !!ranges;
    $("cm-h").textContent = tr("Communauté simulée"); $("cm-l").textContent = tr("gain contre le prix fournisseur du même quart d'heure");
    if (!ranges) { $("cm-cells").innerHTML = ""; $("cm-why").textContent = ""; return; }
    const s = shareSim(M.rows, { ranges, part, price: cp, days: $("cm-days").value });
    $("cm-cells").innerHTML = cell(tr("Gain sur la période"), sgn(s.eur), tr("{v} kWh partagés", { v: fr(s.kwh, 0) }), s.eur >= 0 ? "pos" : "neg") +
      cell(tr("Gain sur 12 mois"), sgn(s.eur * yf, 0), tr("extrapolation"), s.eur >= 0 ? "pos" : "neg") + bandCells(s, tr("gain"));
    const dl = { all: tr("tous les jours"), wd: tr("semaine"), we: tr("week-end") }[$("cm-days").value];
    $("cm-why").textContent = tr("Simulation : {p} de la consommation entre {r} ({d}) couverte par la communauté à {c} €/kWh, comparée au prix fournisseur du même quart d'heure.", { p: pct(part), r: $("cm-range").value.trim(), d: dl, c: fr(cp, 4) }) + " " +
      (real && real.kwh > 0 ? tr("Constat réel sur la période : {v} kWh partagés, bilan {e}.", { v: fr(real.kwh, 0), e: sgn(real.eur) }) + " " : "") +
      tr("Le partage perd de l'argent quand il remplace des kWh creux moins chers que lui (creuse {c} € contre {s} € partagé).", { c: pmin, s: fr(cp, 4) });
  }

  // 6. solaire
  function renderSolar() {
    const on = $("pv-on").checked; $("pv-body").hidden = !on; $("pv-off").hidden = on;
    if (!on) return;
    const inj = $("pv-inj").checked; $("pv-cm").disabled = !inj; $("pv-tar").disabled = !inj; $("pv-cmp").disabled = !inj || !$("pv-cm").checked;
    const o = solar(M.rows, M.days, { kwc: Math.max(0, num("pv-kwc")), or: $("pv-or").value, inject: inj, tariff: num("pv-tar"), community: $("pv-cm").checked, cprice: num("pv-cmp") });
    $("pv-cells").innerHTML = cell(tr("Production"), fr(o.prod, 0) + " kWh", tr("{y} kWh par an", { y: fr(o.yearProd, 0) })) +
      cell(tr("Autoconsommation"), pct(o.selfRate), tr("{v} kWh consommés sur place", { v: fr(o.self, 0) })) +
      cell(tr("Autoproduction"), pct(o.autoRate), tr("part de ta consommation couverte")) +
      cell(tr("Économie"), eur(o.saved), tr("kWh non achetés au fournisseur")) +
      cell(tr("Recette"), eur(o.income), inj ? tr("{v} kWh de surplus vendus", { v: fr(o.surplus, 0) }) : tr("{v} kWh de surplus perdus", { v: fr(o.surplus, 0) })) +
      cell(tr("Gain sur la période"), eur(o.gain), tr("économie + recette"), "pos") +
      cell(tr("Gain sur 12 mois"), eur(o.yearGain, 0), tr("{v} € par kWh produit", { v: fr(o.perKwh, 3) }), "pos");
    drawPv(o);
    $("pv-why").textContent = tr("Estimation : production mensuelle typique au Luxembourg ({y} kWh/kWc par an), répartie en cloche entre lever et coucher du soleil.", { y: PV_YEAR }) + " " +
      tr("Sur 12 mois : production annuelle selon le profil mensuel, valorisée à la valeur moyenne d'un kWh produit sur la période.") + " " +
      tr("Le modèle suppose un jour moyen sans nuages et surestime l'autoconsommation ; l'été, sans chauffage, une plus grande part du surplus part sur le réseau.");
  }

  function drawPv(o) {
    const svg = $("pv-chart"), W = 1000, H = 240, pad = { l: 44, r: 10, t: 12, b: 24 }; svg.replaceChildren();
    const slot = (W - pad.l - pad.r) / 24, top = Math.max(0.2, ...o.cH, ...o.pH) * 1.1, y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
    for (let i = 0; i <= 4; i++) { const v = (top * i) / 4; svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "a-gridline" }));
      svg.appendChild(el("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "a-axis" }, fr(v, v < 1 ? 2 : 1))); }
    o.cH.forEach((v, h) => svg.appendChild(el("rect", { x: pad.l + slot * h + slot * 0.18, y: y(v), width: slot * 0.64, height: y(0) - y(v), class: "c-bar-cons" })));
    const pts = o.pH.map((v, h) => [pad.l + slot * h + slot / 2, y(v)]);
    svg.appendChild(el("path", { d: `M${pts[0][0].toFixed(1)} ${y(0)}` + pts.map(([x, yy]) => `L${x.toFixed(1)} ${yy.toFixed(1)}`).join("") + `L${pts[23][0].toFixed(1)} ${y(0)}Z`, class: "c-pv-area" }));
    svg.appendChild(el("path", { d: pts.map(([x, yy], i) => (i ? "L" : "M") + x.toFixed(1) + " " + yy.toFixed(1)).join(""), class: "c-pv-line" }));
    for (let h = 0; h < 24; h += 3) svg.appendChild(el("text", { x: pad.l + slot * h, y: H - 6, class: "a-axis" }, `${h} h`));
    svg._fn = (p) => { const h = Math.floor((p.x - pad.l) / slot); if (h < 0 || h > 23) return null;
      return `<div class="tip-h">${h} h - ${h + 1} h</div>` + trow("var(--mist)", tr("consommation"), fr(o.cH[h], 2) + " kWh") + trow("var(--t-warm)", tr("production"), fr(o.pH[h], 2) + " kWh"); };
    if (!svg._hv) { svg._hv = 1; hover(svg, (p) => svg._fn?.(p)); }
  }

  // Offres du marché : comparateur officiel ILR Calculix (www.calculix.lu), relevé du 22/11/2026, réseau Creos, 12 000 kWh/an,
  // profil ménage, remises nouveaux clients exclues. e = composante énergie HT €/kWh, f = frais fixes fournisseur HT €/an.
  // dyn : prix variable ; « bands » = même grille horaire que naturstroum home drive (+ écart HT), sinon moyenne Calculix (indicatif).
  const MARKET = [
    { s: "SUDenergie", n: "Mäi Stroum smart", e: 0.106975, f: 42, dyn: "spot", calc: 1874.66 },
    { s: "SUDenergie", n: "mäi Stroum", e: 0.1125, f: 42, calc: 1946.27 },
    { s: "Enovos", n: "fix 3 naturstroum home mono 2027-01", e: 0.11975, f: 48, calc: 2046.71, note: "prix garanti jusqu'au 31/12/2029" },
    { s: "Sudstroum", n: "TERRA", e: 0.1229, f: 45, calc: 2084.29 },
    { s: "Enovos", n: "fix 3 nova naturstroum home mono 2027-01", e: 0.12325, f: 48, calc: 2092.07, note: "prix garanti jusqu'au 31/12/2029" },
    { s: "Sudstroum", n: "TERRA INVEST", e: 0.1269, f: 45, calc: 2136.13 },
    { s: "Enovos", n: "naturstroum home drive", f: 48, dyn: "bands", add: 0, calc: 2156.75, mine: true },
    { s: "Enovos", n: "nova naturstroum home drive", f: 48, dyn: "bands", add: 0.0035, calc: 2202.11 },
    { s: "Enovos", n: "naturstroum home", e: 0.13213, f: 48, calc: 2207.15 },
    { s: "Energy Revolt", n: "BEE FLEXIBLE", e: 0.133337, f: 42, dyn: "spot", calc: 2216.31 },
    { s: "Enovos", n: "nova naturstroum", e: 0.13563, f: 48, calc: 2252.51 },
    { s: "Energy Revolt", n: "BEE REVOLT", e: 0.138, f: 42, calc: 2276.75 },
  ];
  function renderMarket(cur) {
    const vat = T.vat ?? 0.08, per = ((T.tax ?? 0) + (T.comp ?? 0) + (T.net ?? 0)) * (1 + vat), pref = FIX[T.pref] ? T.pref : 7;
    const monthly = (f) => (f / 12 + FIX[pref] + METER) * (1 + vat);
    const rows = MARKET.map((o) => {
      const price = o.dyn === "bands" ? (r) => r.price + o.add * (1 + vat) : () => o.e * (1 + vat) + per;
      // Ton offre : ton fixe réel (remises comprises, ex. Remise Connect) ; les autres : grille Calculix sans remise.
      return { o, r: offer(M.rows, M.days, T.shared, price, o.mine && T.monthly ? T.monthly : monthly(o.f)) };
    }).sort((a, b) => a.r.year - b.r.year);
    const head = ["Fournisseur", "Offre", "Énergie HT c€/kWh", "Fixe fournisseur HT €/an", "Ta conso, 12 mois", "Écart", "Calculix 12 000 kWh"];
    $("mk-table").innerHTML = `<thead><tr>${head.map((h) => `<th>${tr(h)}</th>`).join("")}</tr></thead><tbody>` + rows.map(({ o, r }) => {
      const d = r.year - cur.year, cls = Math.abs(d) < 1 ? "" : d < 0 ? "pos" : "neg";
      const kind = o.dyn === "spot" ? tr("variable (marché)") : o.dyn === "bands" ? tr("tranches horaires") : tr("prix fixe");
      return `<tr${o.mine ? ' class="mk-mine"' : ""}><td>${o.s}</td><td>${o.n}${o.mine ? " · " + tr("ton offre") : ""}<br><span class="label">${kind}${o.note ? " · " + tr(o.note) : ""}</span></td>` +
        `<td>${o.dyn === "bands" ? tr("grille") + (o.add ? ` +${fr(o.add * 100, 2)}` : "") : fr(o.e * 100, 3)}${o.dyn === "spot" ? "*" : ""}</td><td>${fr(o.f, 0)}</td>` +
        `<td>${fr(r.year, 0)} €</td><td class="${cls}">${Math.abs(d) < 1 ? "-" : (d > 0 ? "+" : "−") + fr(Math.abs(d), 0) + " €"}</td><td>${fr(o.calc, 0)} €</td></tr>`;
    }).join("") + "</tbody>";
    $("mk-why").textContent = tr("Source : comparateur officiel de l'ILR (calculix.lu), relevé le 22/11/2026 pour le réseau Creos et 12 000 kWh/an, remises de bienvenue exclues. Chaque offre est recalculée sur ta consommation réelle, quart d'heure par quart d'heure, avec le même réseau Creos, la même puissance de référence et le même partage.") + " " +
      tr("* Prix variable : moyenne Calculix sur un profil ménage, indicative ; le vrai coût dépend des prix du marché à chaque heure.") + " " +
      tr("La colonne Calculix est leur total pour 12 000 kWh avec un profil ménage type, pour vérifier l'ordre de grandeur.") + " " + tr("Ton offre garde ton fixe réel, remises comprises ; les autres offres sont comptées sans remise particulière.");
  }

  function renderSims() { const cur = offer(M.rows, M.days, T.shared, (r) => r.price, T.monthly); renderOffers(cur); renderMarket(cur); renderPref(); renderShare(); renderSolar(); }
  function render() {
    if (!inited) initInputs();
    const rs = M.rows;
    $("c-range").textContent = rs.length ? `${tr("compteur")} ${day(rs[0].day)} → ${day(rs[rs.length - 1].day)}` : tr("pas de données compteur");
    renderSummary(); renderSims();
  }

  // Période : une rangée de boutons (7 j, 30 j, un par mois, tout), rechargement au clic.
  const addD = (k, n) => new Date(Date.parse(k + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const nDays = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
  const dShort = (k) => new Date(k + "T12:00:00Z").toLocaleDateString(LOC, { day: "numeric", month: "short", timeZone: "UTC" });
  let SPAN = null, seq = 0;
  function presets(sp) {
    const t = sp.to, out = [[tr("7 j"), addD(t, -6), t], [tr("30 j"), addD(t, -29), t]];
    for (let m = sp.from.slice(0, 7); m <= t.slice(0, 7); m = addD(m + "-28", 7).slice(0, 7)) {
      const end = addD(addD(m + "-28", 7).slice(0, 7) + "-01", -1);
      out.push([new Date(m + "-15T12:00:00Z").toLocaleDateString(LOC, { month: "short", timeZone: "UTC" }).replace(".", ""), m + "-01", end]);
    }
    out.push([tr("Tout"), sp.from, t]);
    return out.map(([n, a, b]) => [n, a < sp.from ? sp.from : a, b > t ? t : b]);
  }
  const periodLabel = (a, b) => `${dShort(a)} → ${dShort(b)} · ${nDays(a, b) + 1} ${tr("j")}`;
  $("a-presets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    $("a-presets").querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    $("c-period-v").textContent = periodLabel(b.dataset.a, b.dataset.b); load(b.dataset.a, b.dataset.b); });

  function load(d0, d1) {
    const my = ++seq, q = d0 ? `?d0=${d0}&d1=${d1}` : "";
    document.body.classList.add("a-busy");
    fetch(BASE + "/api/costdata" + q, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => {
      if (my !== seq) return;
      if (j.error) throw j.error;
      document.body.classList.remove("a-busy");
      const sp = j.period?.span;
      if (sp && !SPAN) { SPAN = sp;
        $("a-presets").innerHTML = presets(sp).map(([n, a, b]) => `<button data-a="${a}" data-b="${b}" aria-pressed="false">${n}</button>`).join("");
        const all = $("a-presets").lastElementChild; all.setAttribute("aria-pressed", "true");
        $("c-period-v").textContent = periodLabel(all.dataset.a, all.dataset.b);
        $("c-period").hidden = false; }
      D = j; T = j.tariff; M = prep(j);
      if (!M.rows.length) { $("c-wait").hidden = false; $("c-wait").textContent = tr("Pas de données compteur sur cette période."); return; }
      $("c-wait").hidden = true;
      render();
    }).catch((e) => { if (my !== seq) return; document.body.classList.remove("a-busy");
      $("c-wait").hidden = false; $("c-wait").textContent = e === 404 ? tr("Coûts réservés à l'espace privé.") : tr("Coûts indisponibles pour le moment."); });
  }
  load();
})();
